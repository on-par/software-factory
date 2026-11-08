import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { createLogger } from '../logger/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { ModelRegistry } from '../models/index.js';
import { CliModelExecutor } from '../router/index.js';
import { type OtlpTestCollector, startOtlpTestCollector } from '../testing/otlp-collector.js';
import { runCommand } from '../utils/command-runner.js';
import { defaultExecFn } from '../utils/exec.js';
import { closeCommandOutputSession, openCommandOutput, startCommandOutputSession, withModelOutput } from './tap.js';

let collector: OtlpTestCollector;
const dirs = createTempDirs();

beforeEach(async () => {
  vi.unstubAllEnvs();
  collector = await startOtlpTestCollector();
  vi.stubEnv('FACTORY_COMMAND_STREAM_DIR', '');
  vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', collector.endpoint);
  vi.stubEnv('OTEL_EXPORTER_OTLP_PROTOCOL', 'http/json');
});
afterEach(async () => {
  await closeCommandOutputSession('exit', 2_000);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await collector.close();
  await dirs.cleanup();
});

const CHILD = ['node', '-e', "console.log('SAME-OUT'); console.error('SAME-ERR'); process.exitCode = 3"];
const SIGNALS = ['exit', 'beforeExit', 'SIGINT', 'SIGTERM', 'uncaughtException'] as const;
const listeners = () => SIGNALS.map((s) => process.listenerCount(s));
/** Timers and sockets: what an exporter would add. Child-process pipes close on their own schedule, so skip them. */
const handles = () =>
  process
    .getActiveResourcesInfo()
    .filter((r) => r === 'Timeout' || r === 'Immediate' || r.startsWith('TCP'))
    .sort();

describe('disabled command output export', () => {
  const cases: [string, Record<string, string>][] = [
    ['no opt-in (OTEL_* alone never enables it)', {}],
    ['an unsupported opt-in value', { FACTORY_COMMAND_OUTPUT_EXPORT: 'yes' }],
    ['OTEL_SDK_DISABLED=true', { FACTORY_COMMAND_OUTPUT_EXPORT: 'otlp', OTEL_SDK_DISABLED: 'true' }],
    ['OTEL_LOGS_EXPORTER=none', { FACTORY_COMMAND_OUTPUT_EXPORT: 'otlp', OTEL_LOGS_EXPORTER: 'none' }],
  ];

  it.each(cases)('%s: no requests, no extra listeners or timers, identical results', async (_name, env) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const baseline = await runCommand(CHILD);
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const beforeListeners = listeners();
    const beforeHandles = handles();
    await startCommandOutputSession({ version: 't' });
    expect(openCommandOutput(['true'])).toBeUndefined();
    const result = await runCommand(CHILD);
    const execResult = await defaultExecFn('echo SAME-EXEC', {});
    expect(await closeCommandOutputSession('exit')).toBeUndefined();
    expect(result).toEqual(baseline);
    expect(execResult).toEqual({ stdout: 'SAME-EXEC\n', stderr: '' });
    expect(listeners()).toEqual(beforeListeners);
    // No timer or socket kind may grow; one an earlier test left behind may expire meanwhile.
    const count = (list: string[]) =>
      list.reduce<Record<string, number>>((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {});
    const before = count(beforeHandles);
    for (const [kind, n] of Object.entries(count(handles()))) expect(n, kind).toBeLessThanOrEqual(before[kind] ?? 0);
    expect(collector.requests).toHaveLength(0);
  });

  it('stays off with a warning when export is requested but no OTLP endpoint is configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
    vi.stubEnv('FACTORY_COMMAND_OUTPUT_EXPORT', 'otlp');
    await startCommandOutputSession({ version: 't' });
    expect(openCommandOutput(['true'])).toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toContain('no OTLP logs endpoint');
  });

  it('stays off with a warning for the unsupported grpc protocol', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('FACTORY_COMMAND_OUTPUT_EXPORT', 'otlp');
    vi.stubEnv('OTEL_EXPORTER_OTLP_LOGS_PROTOCOL', 'grpc');
    await startCommandOutputSession({ version: 't' });
    expect(openCommandOutput(['true'])).toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toContain('grpc');
  });
});

function fakeAgent(body: string): string {
  const dir = dirs.makeSync('sf-otlp-agent-');
  const path = join(dir, 'agent.sh');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('what command output export never sends', () => {
  beforeEach(() => vi.stubEnv('FACTORY_COMMAND_OUTPUT_EXPORT', 'otlp'));

  it('never exports model output from a harness run, while other exec output is exported', async () => {
    await startCommandOutputSession({ version: 't' });
    const agent = fakeAgent('cat > /dev/null; echo "MODEL-OUTPUT-MARKER"; echo "MODEL-STDERR-MARKER" >&2');
    const config: ModelsConfig = {
      version: 1,
      models: {
        fake: {
          provider: 'custom',
          tier: 'boss',
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
          codex: true,
          harness: 'fake-agent',
        },
      },
      tiers: { boss: ['fake'] },
      failover: { triggers: ['rate_limit'], maxRetries: 0, cooldownMs: 0 },
      routingRules: {},
      harnesses: {
        'fake-agent': { command: agent, prompt: 'stdin', output: 'stdout', agentic: true, usage: 'none' },
      },
    };
    const routesConfig: RoutesConfig = {
      version: 1,
      routes: { build_codex: { tier: 'boss', description: 'x', requires: 'codex' } },
    };
    const out = await new CliModelExecutor().runModel('fake', 'PROMPT-TEXT-MARKER', {
      worktree: dirs.makeSync('sf-otlp-wt-'),
      timeoutSeconds: 30,
      task: 'build_codex',
      registry: new ModelRegistry(config),
      routesConfig,
    });
    expect(out.trim()).toBe('MODEL-OUTPUT-MARKER');
    await withModelOutput(() => defaultExecFn('echo MODEL-SCOPED-MARKER', {}));
    await defaultExecFn('echo COMMAND-OUTPUT-MARKER', {});
    const summary = await closeCommandOutputSession('exit', 10_000);
    expect(summary?.withheld).toBe(2);
    const all = JSON.stringify(collector.records());
    expect(all).toContain('COMMAND-OUTPUT-MARKER');
    for (const marker of ['MODEL-OUTPUT-MARKER', 'MODEL-STDERR-MARKER', 'MODEL-SCOPED-MARKER', 'PROMPT-TEXT-MARKER'])
      expect(all).not.toContain(marker);
  }, 60_000);

  it("never exports the CLI's own stdout, stderr or logger output", async () => {
    await startCommandOutputSession({ version: 't' });
    const dir = dirs.makeSync('sf-otlp-logger-');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    console.log('CLI-OWN-STDOUT-MARKER');
    console.error('CLI-OWN-STDERR-MARKER');
    createLogger(join(dir, 'events.ndjson'), {}, { out: { write: () => true } }).info(
      'adr_context',
      'CLI-LOGGER-MARKER',
    );
    await runCommand(['node', '-e', "console.log('NESTED-ONLY-MARKER')"]);
    log.mockRestore();
    err.mockRestore();
    await closeCommandOutputSession('exit', 10_000);
    const all = JSON.stringify(collector.records());
    expect(all).toContain('NESTED-ONLY-MARKER');
    for (const marker of ['CLI-OWN-STDOUT-MARKER', 'CLI-OWN-STDERR-MARKER', 'CLI-LOGGER-MARKER'])
      expect(all).not.toContain(marker);
  }, 30_000);
});
