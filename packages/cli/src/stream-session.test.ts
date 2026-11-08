import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs, startOtlpTestCollector } from '@on-par/factory-core/testing';

import { closeStreamSession, startStreamSession } from './stream-session.js';

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

/** Runs the real CLI entry (TypeScript sources via tsx) in a child process. */
function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['--conditions=development', '--import', 'tsx', CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 60_000,
  });
}

/** Async variant of runCli: the in-process OTLP collector must keep serving while the CLI runs. */
function runCliAsync(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', CLI, ...args], {
    env: { ...process.env, ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
  return new Promise<{ status: number | null; stdout: string; stderr: string; pid?: number }>((resolve) =>
    child.on('close', (status) => resolve({ status, stdout, stderr, pid: child.pid })),
  );
}

describe('CLI command stream session files', () => {
  it('writes a session start and end file before and after any command', async () => {
    const streamDir = join(await dirs.make('sf-cli-session-'), 'streams');

    const r = runCli(['--version'], { FACTORY_COMMAND_STREAM_DIR: streamDir });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(VERSION);
    const files = readdirSync(streamDir);
    expect(files).toHaveLength(2);
    const start = String(files.find((n) => !n.endsWith('-end.json')));
    const end = String(files.find((n) => n.endsWith('-end.json')));
    expect(start).toMatch(new RegExp(`^session-\\d+-${r.pid}\\.json$`));
    expect(end).toBe(start.replace(/\.json$/, '-end.json'));
    const startJson = JSON.parse(readFileSync(join(streamDir, start), 'utf-8')) as Record<string, unknown>;
    expect(startJson).toEqual({ format: 1, pid: r.pid, startedAt: expect.any(String), version: VERSION });
    const endJson = JSON.parse(readFileSync(join(streamDir, end), 'utf-8')) as Record<string, unknown>;
    expect(endJson).toEqual({
      format: 1,
      pid: r.pid,
      commands: 0,
      writeErrors: 0,
      unavailable: false,
      endedAt: expect.any(String),
    });
    expect(Date.parse(String(endJson.endedAt))).toBeGreaterThanOrEqual(Date.parse(String(startJson.startedAt)));
  }, 90_000);

  it('writes no session file when the stream dir is not set', () => {
    const r = runCli(['--version'], { FACTORY_COMMAND_STREAM_DIR: '' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(VERSION);
    expect(readdirSync(process.cwd()).filter((n) => n.startsWith('session-'))).toEqual([]);
  }, 90_000);

  it('exports a session start and end record over OTLP for a CLI command when opted in', async () => {
    const collector = await startOtlpTestCollector();
    try {
      // No arguments: main() prints the overview and returns normally (commander's --version exits on its own).
      const r = await runCliAsync([], {
        FACTORY_COMMAND_STREAM_DIR: '',
        FACTORY_COMMAND_OUTPUT_EXPORT: 'otlp',
        OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.length).toBeGreaterThan(0);
      const records = collector.records();
      expect(records.map((x) => x.eventName)).toEqual(['factory.session.start', 'factory.session.end']);
      expect(records[1].attrs).toMatchObject({ 'factory.session.reason': 'exit', 'factory.session.complete': true });
      expect(records[0].resource).toMatchObject({ 'service.version': VERSION, 'process.pid': r.pid });
      // The CLI's own stdout (the overview) is never exported; only nested command output is.
      expect(JSON.stringify(records)).not.toContain(r.stdout.trim().split('\n')[0]);
    } finally {
      await collector.close();
    }
  }, 90_000);
});

describe('startStreamSession / closeStreamSession (in process)', () => {
  it('start and close are no-ops that add no exit listener when no sink is on', async () => {
    vi.stubEnv('FACTORY_COMMAND_STREAM_DIR', '');
    vi.stubEnv('FACTORY_COMMAND_OUTPUT_EXPORT', '');
    const exitListeners = process.listenerCount('exit');
    try {
      await startStreamSession();
      await expect(closeStreamSession('exit')).resolves.toBeUndefined();
      expect(process.listenerCount('exit')).toBe(exitListeners);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
