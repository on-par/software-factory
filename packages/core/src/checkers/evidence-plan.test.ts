import { describe, expect, it } from 'vitest';
import type { EvidencePlanEntry } from '@on-par/contracts';
import { shellEscape } from '../utils/index.js';
import { wrapCommandInSandbox, type SandboxPolicy } from '../sandbox/index.js';
import { resolveEvidenceAllowlist } from './evidence-allowlist.js';
import { runEvidencePlan } from './evidence-plan.js';
import type { CommandResult } from '../utils/command-runner.js';

const policy = (runtime: SandboxPolicy['runtime'] = 'firejail'): SandboxPolicy => ({
  runtime,
  worktree: '/tmp/lane',
  writablePaths: ['/tmp/lane', '/tmp'],
  writableFilePrefixes: ['/tmp/prefix'],
  allowHosts: ['example.com'],
  proxyUrl: 'http://proxy',
  cpuMs: 100,
  memMb: 256,
});
const commandResult = (exitCode: number, stdout = '', stderr = ''): CommandResult => ({
  command: [],
  stdout,
  stderr,
  exitCode,
  killed: false,
  timedOut: false,
  ok: exitCode === 0,
});
const entry = (kind: EvidencePlanEntry['kind'], fields: Record<string, string>): EvidencePlanEntry =>
  ({ kind, claim: 'claim', ...fields }) as EvidencePlanEntry;

describe('evidence plan runner', () => {
  it('evidence runner returns per-entry outcomes and scopes its own test', async () => {
    const seen: string[][] = [];
    const allowlist = resolveEvidenceAllowlist(
      { packageManager: 'npm', scripts: { test: 'vitest run', lint: 'eslint' } },
      null,
    );
    const entries = [
      entry('fail-to-pass-test', { test: '"src/a test.ts" --run' }),
      entry('command', { command: 'lint --fix', passWhen: 'done' }),
    ];
    const results = await runEvidencePlan(entries, allowlist, {
      worktree: '/tmp/lane',
      sandbox: policy(),
      runCommand: async (argv) => {
        seen.push([...argv]);
        return commandResult(0);
      },
    });
    expect(results.map((r) => r.status)).toEqual(['PASS', 'PASS']);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.[0]).toBe('/bin/sh');
    expect(seen[0]?.[2]).toContain(shellEscape('src/a test.ts'));
    expect(seen[0]?.[2]).toContain(shellEscape('--run'));
  });

  it('evidence runner FAILs an allowlisted command that exits non-zero', async () => {
    const long = 'x'.repeat(2500);
    const result = await runEvidencePlan(
      [entry('command', { command: 'check', passWhen: 'ok' })],
      new Map([['check', ['echo', 'hi']]]),
      {
        worktree: '/tmp/lane',
        sandbox: policy(),
        runCommand: async () => commandResult(1, long),
      },
    );
    expect(result[0]).toMatchObject({
      claim: 'claim',
      kind: 'command',
      status: 'FAIL',
      reason: 'exited with code 1',
      outputTail: long.slice(-2000),
    });
  });

  it('evidence runner SKIPs a piped command and never executes it', async () => {
    let calls = 0;
    const result = await runEvidencePlan(
      [entry('command', { command: 'check | tee /tmp/out', passWhen: 'ok' })],
      new Map([['check', ['echo']]]),
      {
        worktree: '/tmp/lane',
        sandbox: policy(),
        runCommand: async () => {
          calls++;
          return commandResult(0);
        },
      },
    );
    expect(result[0]).toMatchObject({ status: 'SKIP', reason: 'not allowlisted' });
    expect(calls).toBe(0);
  });

  it('evidence runner skips unsupported evidence without spawning', async () => {
    let calls = 0;
    const entries = [
      entry('command', { command: 'missing', passWhen: 'ok' }),
      entry('screenshot', { route: '/settings' }),
      entry('none', { reason: 'manual proof' }),
    ];
    const result = await runEvidencePlan(entries, new Map(), {
      worktree: '/tmp/lane',
      sandbox: policy(),
      runCommand: async () => {
        calls++;
        return commandResult(0);
      },
    });
    expect(result.map(({ status, reason }) => [status, reason])).toEqual([
      ['SKIP', 'not allowlisted'],
      ['SKIP', '/settings'],
      ['SKIP', 'manual proof'],
    ]);
    expect(await runEvidencePlan(null, new Map(), { worktree: '/tmp/lane' })).toEqual([]);
    expect(calls).toBe(0);
  });

  it('skips executable evidence when the sandbox cannot contain it', async () => {
    let calls = 0;
    const entries = [entry('command', { command: 'check', passWhen: 'ok' })];
    for (const runtime of [undefined, 'none', 'docker-sandbox'] as const) {
      const results = await runEvidencePlan(entries, new Map([['check', ['echo']]]), {
        worktree: '/tmp/lane',
        sandbox: runtime ? policy(runtime) : undefined,
        runCommand: async () => {
          calls++;
          return commandResult(0);
        },
      });
      expect(results[0]).toMatchObject({ status: 'SKIP', reason: 'sandbox unavailable' });
    }
    expect(calls).toBe(0);
  });

  it('evidence runner wraps a network-disabled policy and forwards pgid', async () => {
    for (const runtime of ['firejail', 'sandbox-exec'] as const) {
      const original = policy(runtime);
      let pgid = 0;
      let wrapped = '';
      await runEvidencePlan(
        [entry('command', { command: 'check "a b"', passWhen: 'ok' })],
        new Map([['check', ['echo', 'x']]]),
        {
          worktree: '/tmp/lane',
          sandbox: original,
          env: { PORT: '3100', FACTORY_RUN_CONFIG_JSON: 'bad' },
          testsTimeoutSeconds: 12,
          onPgid: (value) => {
            pgid = value;
          },
          runCommand: async (argv, options) => {
            wrapped = argv[2]!;
            options?.onPgid?.(987);
            expect(options).toMatchObject({ cwd: '/tmp/lane', timeoutMs: 12000, env: { PORT: '3100' } });
            return commandResult(0);
          },
        },
      );
      expect(wrapped).toBe(
        wrapCommandInSandbox(['echo', 'x', 'a b'].map(shellEscape).join(' '), {
          ...original,
          allowHosts: [],
          proxyUrl: undefined,
        }),
      );
      expect(pgid).toBe(987);
      expect(original.allowHosts).toEqual(['example.com']);
      expect(original.writablePaths).toEqual(['/tmp/lane', '/tmp']);
    }
  });

  it('fails on timeout, termination, and spawn rejection then continues in order', async () => {
    const entries = [
      entry('command', { command: 'check', passWhen: 'ok' }),
      entry('command', { command: 'check', passWhen: 'ok' }),
      entry('command', { command: 'check', passWhen: 'ok' }),
    ];
    let n = 0;
    const results = await runEvidencePlan(entries, new Map([['check', ['echo']]]), {
      worktree: '/tmp/lane',
      sandbox: policy(),
      runCommand: async () => {
        n++;
        if (n === 1) return { ...commandResult(0), timedOut: true };
        if (n === 2) return { ...commandResult(-1), killed: true };
        throw new Error('spawn broke');
      },
    });
    expect(results.map((r) => r.reason)).toEqual([
      'timed out after 300s',
      'terminated',
      'execution error: spawn broke',
    ]);
    expect(results.map((r) => r.claim)).toEqual(['claim', 'claim', 'claim']);
  });
});
