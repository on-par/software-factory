import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs, type OtlpTestCollector, startOtlpTestCollector } from '@on-par/factory-core/testing';

import { installShutdown, SHUTDOWN_EXIT_CODE, SIGNAL_FLUSH_BUDGET_MS, type ShutdownSignals } from './shutdown.js';

const originalExitCode = process.exitCode;
const tempDirs = createTempDirs();
let collector: OtlpTestCollector | undefined;
afterEach(async () => {
  process.exitCode = originalExitCode;
  await tempDirs.cleanup();
  await collector?.close();
  collector = undefined;
});

describe('installShutdown command output flush', () => {
  it('flushes command output after the process-group sweep and before exiting 130', async () => {
    const calls: string[] = [];
    const signals = new EventEmitter() as ShutdownSignals & EventEmitter;
    const exit = vi.fn((code: number) => void calls.push(`exit ${code}`));
    installShutdown(new AbortController(), {
      stopFile: () => '/unused',
      writeStop: () => {},
      signals,
      exit,
      log: () => {},
      killTracked: async () => void calls.push('sweep'),
      flushOutput: async (budgetMs) => void calls.push(`flush ${budgetMs}`),
    });
    signals.emit('SIGTERM', 'SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(calls).toEqual(['sweep', `flush ${SIGNAL_FLUSH_BUDGET_MS}`, `exit ${SHUTDOWN_EXIT_CODE}`]);
  });

  it('still exits 130 when the flush rejects', async () => {
    const signals = new EventEmitter() as ShutdownSignals & EventEmitter;
    const exit = vi.fn();
    installShutdown(new AbortController(), {
      stopFile: () => '/unused',
      writeStop: () => {},
      signals,
      exit,
      log: () => {},
      killTracked: async () => {},
      flushOutput: () => Promise.reject(new Error('collector gone')),
    });
    signals.emit('SIGINT', 'SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
  });
});

const CLI_SRC = fileURLToPath(new URL('..', import.meta.url));

describe('SIGTERM through the shutdown path with command output export on', () => {
  it('exits 130 and flushes the session end record within the budget', async () => {
    collector = await startOtlpTestCollector();
    const dir = await tempDirs.make('sf-sigterm-otlp-');
    const script = `
      import { startStreamSession } from ${JSON.stringify(join(CLI_SRC, 'stream-session.ts'))};
      import { withShutdown } from ${JSON.stringify(join(CLI_SRC, 'cli/shutdown.ts'))};
      import { runCommand } from '@on-par/factory-core/internal';
      await startStreamSession();
      await withShutdown(
        () => runCommand(['node', '-e', "console.log('SIGTERM-CHILD-LINE'); setInterval(() => {}, 1000)"], {
          onPgid: () => {},
          timeoutMs: 60000,
        }),
        { stopFile: () => ${JSON.stringify(join(dir, 'STOP'))}, graceMs: 500 },
      )();
    `;
    const child = spawn(
      process.execPath,
      ['--conditions=development', '--import', 'tsx', '--input-type=module', '-e', script],
      {
        cwd: join(CLI_SRC, '..'),
        env: {
          ...process.env,
          FACTORY_COMMAND_STREAM_DIR: '',
          FACTORY_COMMAND_OUTPUT_EXPORT: 'otlp',
          OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint,
          OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    await collector.waitFor((rs) => rs.some((r) => r.body === 'SIGTERM-CHILD-LINE'), 60_000);
    const signalledAt = Date.now();
    child.kill('SIGTERM');
    const code = await exited;
    expect(code, stderr).toBe(SHUTDOWN_EXIT_CODE);
    expect(Date.now() - signalledAt).toBeLessThan(500 + SIGNAL_FLUSH_BUDGET_MS + 2_000);
    const end = collector.records().find((r) => r.eventName === 'factory.session.end');
    expect(end?.attrs['factory.session.reason']).toBe('signal');
    const cmdEnd = collector.records().find((r) => r.eventName === 'factory.command.end');
    expect(cmdEnd?.attrs['process.exit.signal'] ?? cmdEnd?.attrs['factory.command.interrupted']).toBeTruthy();
  }, 90_000);
});
