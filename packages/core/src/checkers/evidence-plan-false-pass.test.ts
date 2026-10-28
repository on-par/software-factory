import { access, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { EvidencePlanEntry } from '@on-par/contracts';

import type { SandboxPolicy } from '../sandbox/index.js';
import { execGit } from '../utils/git-exec.js';
import type { CommandResult } from '../utils/command-runner.js';
import { runEvidencePlan } from './evidence-plan.js';

const tempDirs = createTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

const policy = (worktree: string): SandboxPolicy => ({
  runtime: 'firejail',
  worktree,
  writablePaths: [worktree, '/tmp'],
  writableFilePrefixes: [],
  allowHosts: [],
  cpuMs: 100,
  memMb: 256,
});

function commandResult(exitCode: number): CommandResult {
  return { command: [], stdout: '', stderr: '', exitCode, killed: false, timedOut: false, ok: exitCode === 0 };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execGit(args, { cwd })).stdout.trim();
}

async function fixture(fileOnBase = true): Promise<{ lane: string; base: string; entry: EvidencePlanEntry }> {
  const lane = await tempDirs.make('evidence-false-pass-');
  await git(lane, 'init', '-q');
  await git(lane, 'config', 'user.name', 'Evidence Test');
  await git(lane, 'config', 'user.email', 'evidence@example.test');
  if (fileOnBase) await writeFile(join(lane, 'probe.test.ts'), 'base\n');
  await git(lane, 'add', '-A');
  await git(lane, 'commit', '--allow-empty', '-qm', 'base');
  const base = await git(lane, 'rev-parse', 'HEAD');
  await git(lane, 'update-ref', 'refs/remotes/origin/main', base);
  await writeFile(join(lane, 'probe.test.ts'), 'head\n');
  await git(lane, 'add', '-A');
  await git(lane, 'commit', '-qam', 'head');
  return {
    lane,
    base,
    entry: { kind: 'fail-to-pass-test', claim: 'new behavior', test: 'probe.test.ts' },
  };
}

describe('fail-to-pass evidence base comparison', () => {
  it("fail-to-pass that passes on merge-base FAILs as test doesn't exercise the change", async () => {
    const { lane, base, entry } = await fixture();
    const calls: { argv: readonly string[]; cwd?: string; timeoutMs?: number; command?: string }[] = [];
    const results = await runEvidencePlan([entry], new Map([['test', ['npm', 'run', 'test']]]), {
      worktree: lane,
      sandbox: policy(lane),
      env: { PORT: '3100', FACTORY_BASE_URL: 'http://127.0.0.1:3100' },
      testsTimeoutSeconds: 19,
      runCommand: async (argv, options) => {
        calls.push({ argv, cwd: options?.cwd, timeoutMs: options?.timeoutMs, command: argv[2] });
        return commandResult(0);
      },
    });

    expect(results[0]).toMatchObject({ status: 'FAIL', claim: 'new behavior', baseSha: base });
    expect(results[0]?.reason).toContain("test doesn't exercise the change");
    expect(results[0]?.headRun?.exitCode).toBe(0);
    expect(results[0]?.baseRun?.exitCode).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.command).toContain("'probe.test.ts'");
    expect(calls[1]?.command).toContain("'probe.test.ts'");
    expect(calls[0]?.cwd).toBe(lane);
    expect(calls[1]?.cwd).not.toBe(lane);
    expect(calls.map((call) => call.timeoutMs)).toEqual([19_000, 19_000]);
    expect(calls[1]?.command).toContain('npm');
    expect(calls.map((call) => call.command?.includes('--net=none'))).toEqual([true, true]);
    await expect(access(calls[1]?.cwd ?? '')).rejects.toThrow();
    expect(await git(lane, 'worktree', 'list', '--porcelain')).not.toContain('factory-evidence-base');
  });

  it('base failure and head pass records real fail-to-pass and removes worktree', async () => {
    const { lane, base, entry } = await fixture();
    const calls: {
      cwd?: string;
      argv: readonly string[];
      timeoutMs?: number;
      env?: Record<string, string | undefined>;
    }[] = [];
    const before = await git(lane, 'worktree', 'list', '--porcelain');
    const results = await runEvidencePlan([entry], new Map([['test', ['npm', 'run', 'test']]]), {
      worktree: lane,
      sandbox: policy(lane),
      env: { PORT: '3100', FACTORY_APP_PORT: '3100', FACTORY_BASE_URL: 'http://127.0.0.1:3100' },
      testsTimeoutSeconds: 19,
      runCommand: async (argv, options) => {
        calls.push({ cwd: options?.cwd, argv, timeoutMs: options?.timeoutMs, env: options?.env });
        return commandResult(options?.cwd === lane ? 0 : 1);
      },
    });
    expect(results[0]).toMatchObject({
      status: 'PASS',
      baseSha: base,
      headRun: { exitCode: 0, timedOut: false, killed: false },
      baseRun: { exitCode: 1, timedOut: false, killed: false },
    });
    expect(results[0]?.sharedFailure).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.cwd).toBe(lane);
    expect(calls[1]?.cwd).not.toBe(lane);
    expect(calls.map((call) => call.argv[2]?.includes("'probe.test.ts'")).every(Boolean)).toBe(true);
    expect(calls.map((call) => call.timeoutMs)).toEqual([19_000, 19_000]);
    expect(calls.map((call) => call.env?.PORT)).toEqual(['3100', '3100']);
    expect(calls.map((call) => call.env?.FACTORY_APP_PORT)).toEqual(['3100', '3100']);
    await expect(access(calls[1]?.cwd ?? '')).rejects.toThrow();
    expect(await git(lane, 'worktree', 'list', '--porcelain')).toBe(before);
  });

  async function runBothFailing(output: (cwd: string, isHead: boolean) => string) {
    const { lane, entry } = await fixture();
    return runEvidencePlan([entry], new Map([['test', ['npm', 'run', 'test']]]), {
      worktree: lane,
      sandbox: policy(lane),
      env: { PORT: '3100' },
      testsTimeoutSeconds: 19,
      runCommand: async (_argv, options) => ({
        ...commandResult(1),
        stderr: output(options?.cwd ?? '', options?.cwd === lane),
      }),
    });
  }

  it('base and head failing with the same exit code and output set sharedFailure naming the test (#3749)', async () => {
    const results = await runBothFailing(
      (cwd, isHead) =>
        `\u001b[31mError\u001b[0m at ${cwd}/probe.test.ts\nlisten EPERM 127.0.0.1 after ${isHead ? 12 : 340}ms\n`,
    );
    expect(results[0]).toMatchObject({ status: 'FAIL' });
    expect(results[0]?.sharedFailure).toContain(
      'fail-to-pass probe.test.ts failed identically on base and head (exit 1)',
    );
    expect(results[0]?.sharedFailure).toContain('<t>');
    expect(results[0]?.sharedFailure).not.toContain('/tmp');
    expect(results[0]?.reason).toContain(results[0]?.sharedFailure ?? 'missing');
  });

  it('base and head failing with different output leave sharedFailure unset (#3749)', async () => {
    const results = await runBothFailing((_cwd, isHead) => (isHead ? 'head assertion failed' : 'base missing file'));
    expect(results[0]).toMatchObject({ status: 'FAIL' });
    expect(results[0]?.sharedFailure).toBeUndefined();
  });

  it('missing named test on base counts as base failure when head passes', async () => {
    const { lane, entry } = await fixture(false);
    const calls: string[] = [];
    const results = await runEvidencePlan([entry], new Map([['test', ['npm', 'run', 'test']]]), {
      worktree: lane,
      sandbox: policy(lane),
      runCommand: async (_argv, options) => {
        const cwd = options?.cwd ?? '';
        calls.push(cwd);
        const exists = await access(join(cwd, 'probe.test.ts')).then(
          () => true,
          () => false,
        );
        return commandResult(exists ? 0 : 1);
      },
    });
    expect(results[0]).toMatchObject({ status: 'PASS', headRun: { exitCode: 0 }, baseRun: { exitCode: 1 } });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(lane);
    expect(calls[1]).not.toBe(lane);
  });

  it('not allowlisted SKIP never creates or runs a base worktree', async () => {
    const { lane, entry } = await fixture();
    const before = await git(lane, 'worktree', 'list', '--porcelain');
    let calls = 0;
    const results = await runEvidencePlan([entry], new Map(), {
      worktree: lane,
      sandbox: policy(lane),
      runCommand: async () => {
        calls++;
        return commandResult(0);
      },
    });
    expect(results[0]).toMatchObject({ status: 'SKIP', reason: 'not allowlisted' });
    expect(calls).toBe(0);
    expect(await git(lane, 'worktree', 'list', '--porcelain')).toBe(before);
  });

  it('head failure stays failed after the base command also runs', async () => {
    const { lane, entry } = await fixture();
    let calls = 0;
    const results = await runEvidencePlan([entry], new Map([['test', ['npm', 'run', 'test']]]), {
      worktree: lane,
      sandbox: policy(lane),
      runCommand: async () => {
        calls++;
        return commandResult(calls === 1 ? 1 : 0);
      },
    });
    expect(results[0]).toMatchObject({ status: 'FAIL', headRun: { exitCode: 1 }, baseRun: { exitCode: 0 } });
    expect(calls).toBe(2);
  });

  it('base timeout, termination, and spawn rejection are inconclusive and clean up', async () => {
    for (const outcome of ['timeout', 'killed', 'spawn'] as const) {
      const { lane, entry } = await fixture();
      let calls = 0;
      const results = await runEvidencePlan([entry], new Map([['test', ['npm', 'run', 'test']]]), {
        worktree: lane,
        sandbox: policy(lane),
        runCommand: async () => {
          calls++;
          if (calls === 1) return commandResult(0);
          if (outcome === 'spawn') throw new Error('base spawn broke');
          return {
            ...commandResult(outcome === 'timeout' ? 0 : -1),
            timedOut: outcome === 'timeout',
            killed: outcome === 'killed',
          };
        },
      });
      expect(results[0]?.status).toBe('FAIL');
      expect(results[0]?.reason).toContain('inconclusive');
      if (outcome === 'spawn') {
        expect(results[0]?.baseRun).toBeUndefined();
        expect(results[0]?.reason).toContain('base has no completed run record');
      } else {
        expect(results[0]?.baseRun?.timedOut).toBe(outcome === 'timeout');
        expect(results[0]?.baseRun?.killed).toBe(outcome === 'killed');
      }
      expect(await git(lane, 'worktree', 'list', '--porcelain')).not.toContain('factory-evidence-base');
    }
  });

  it('explicit parent ref is authoritative and invalid parent does not fall back', async () => {
    const { lane, base, entry } = await fixture();
    const headSha = await git(lane, 'rev-parse', 'HEAD');
    const seen: string[] = [];
    const authoritative = await runEvidencePlan([entry], new Map([['test', ['npm', 'run', 'test']]]), {
      worktree: lane,
      sandbox: policy(lane),
      parentBaseRef: 'HEAD',
      runCommand: async (_argv, options) => {
        seen.push(options?.cwd ?? '');
        return commandResult(0);
      },
    });
    expect(authoritative[0]).toMatchObject({ status: 'FAIL', baseSha: headSha, baseRun: { exitCode: 0 } });

    seen.length = 0;
    const invalid = await runEvidencePlan([entry], new Map([['test', ['npm', 'run', 'test']]]), {
      worktree: lane,
      sandbox: policy(lane),
      parentBaseRef: 'missing-parent',
      diffBase: base,
      runCommand: async (_argv, options) => {
        seen.push(options?.cwd ?? '');
        return commandResult(0);
      },
    });
    expect(invalid[0]?.status).toBe('FAIL');
    expect(invalid[0]?.reason).toContain("base ref override 'missing-parent'");
    expect(invalid[0]?.baseRun).toBeUndefined();
    expect(seen).toEqual([lane]);
  });

  it('lifecycle failure during base execution still removes the detached checkout', async () => {
    const { lane, entry } = await fixture();
    let calls = 0;
    const result = await runEvidencePlan(
      [entry],
      new Map([['test', ['npm', 'run', 'test']]]),
      {
        worktree: lane,
        sandbox: policy(lane),
        runCommand: async () => {
          calls++;
          return commandResult(0);
        },
      },
      {
        beforeCommand: async () => {},
        afterCommand: async (_command, _pgids) => {
          if (calls > 1) throw new Error('base lifecycle broke');
        },
      },
    );
    expect(result[0]?.status).toBe('FAIL');
    expect(result[0]?.reason).toContain('base lifecycle broke');
    expect(await git(lane, 'worktree', 'list', '--porcelain')).not.toContain('factory-evidence-base');
  });

  it('cleanup failure uses the owned-path fallback and cannot produce PASS', async () => {
    const { lane, entry } = await fixture();
    const results = await runEvidencePlan([entry], new Map([['test', ['npm', 'run', 'test']]]), {
      worktree: lane,
      sandbox: policy(lane),
      runCommand: async (_argv, options) => {
        if (options?.cwd !== lane) await unlink(join(options?.cwd ?? '', '.git'));
        return commandResult(options?.cwd === lane ? 0 : 1);
      },
    });
    expect(results[0]?.status).toBe('FAIL');
    expect(results[0]?.reason).toContain('filesystem cleanup fallback used');
    expect(await git(lane, 'worktree', 'list', '--porcelain')).not.toContain('factory-evidence-base');
  });
});
