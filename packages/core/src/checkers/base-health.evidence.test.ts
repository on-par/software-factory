// Base health evidence on stubbed baseline reports: red wins over inconclusive, an inconclusive result is never
// memoized, a checker crash is inconclusive, and evidence is redacted before it reaches the result or the log.
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { EventKind } from '../events/kinds.js';
import type { ModelRouter } from '../router/index.js';
import type { CommandResult } from '../utils/command-runner.js';
import type { BaselineCheckerComparison, BaselineReport, runBaselineCheckers } from './baseline.js';
import { BASE_HEALTH_CHECKERS, checkBaseHealth, type BaseHealthOptions } from './base-health.js';

const SHA = 'b'.repeat(40);

const revParse = () =>
  vi.fn(async (): Promise<CommandResult> => ({
    command: [],
    stdout: `${SHA}\n`,
    stderr: '',
    exitCode: 0,
    killed: false,
    timedOut: false,
    ok: true,
  }));

let memo: Map<string, Promise<BaselineReport>>;
let log: Mock<(type: EventKind, msg: string) => void>;

beforeEach(() => {
  memo = new Map();
  log = vi.fn<(type: EventKind, msg: string) => void>();
});

function opts(deps: NonNullable<BaseHealthOptions['deps']>): BaseHealthOptions {
  return {
    worktree: '/tmp/wt',
    constitution: null,
    router: {} as ModelRouter,
    env: { A: '1' },
    log,
    deps: { memo, runCommand: revParse(), ...deps },
  };
}

const messages = () => log.mock.calls.map((c) => String(c[1]));

describe('checkBaseHealth inconclusive vs red', () => {
  const VERIFY = 'bash scripts/verify.sh --no-e2e';
  const fail = (checker: string, extra: Partial<BaselineCheckerComparison>): BaselineCheckerComparison => ({
    checker,
    verdict: 'fails-on-base',
    baseResult: 'FAIL',
    ...extra,
  });
  const withCheckers = (checkers: BaselineCheckerComparison[]): BaselineReport => ({
    baseSha: SHA,
    checkers: BASE_HEALTH_CHECKERS.map(
      (checker) => checkers.find((c) => c.checker === checker) ?? { checker, verdict: 'clean-on-base' as const },
    ),
  });

  it('a genuine compile FAIL beside a tests timeout is red on compile, with evidence for both', async () => {
    const runBaseline = vi.fn<typeof runBaselineCheckers>(async () =>
      withCheckers([
        fail('compile', {
          baseDetails: 'tsc -b failed: src/a.ts(1,1): error TS2304',
          baseCommand: { command: 'tsc -b', exitCode: 2, timeoutSeconds: 120 },
        }),
        fail('tests', {
          baseTimedOut: true,
          baseDetails: 'timed out after 300s',
          baseCommand: { command: VERIFY, exitCode: -1, timeoutSeconds: 300 },
        }),
      ]),
    );
    const res = await checkBaseHealth(opts({ runBaseline }));
    expect(res.kind).toBe('red');
    expect(res.failingChecks).toEqual(['compile']);
    expect(res.evidence).toEqual([
      expect.objectContaining({ checker: 'compile', exitCode: 2, command: 'tsc -b' }),
      expect.objectContaining({ checker: 'tests', cause: 'timeout', timeoutSeconds: 300 }),
    ]);
    expect(res.evidence?.[0]).not.toHaveProperty('cause');
  });

  it('drops the in-process memo for an inconclusive result: the next call re-runs the base checks', async () => {
    const runBaseline = vi.fn<typeof runBaselineCheckers>(async () =>
      withCheckers([fail('tests', { baseCommand: { command: VERIFY, exitCode: 127, timeoutSeconds: 300 } })]),
    );
    expect((await checkBaseHealth(opts({ runBaseline }))).kind).toBe('inconclusive');
    expect(memo.size).toBe(0);
    expect((await checkBaseHealth(opts({ runBaseline }))).kind).toBe('inconclusive');
    expect(runBaseline).toHaveBeenCalledTimes(2);
  });

  it('a checker crash on base is inconclusive (checker-error), never red and never green', async () => {
    const runBaseline = vi.fn<typeof runBaselineCheckers>(async () =>
      withCheckers([fail('tests', { baseCheckerError: true, baseDetails: 'unexpected checker error: boom' })]),
    );
    const res = await checkBaseHealth(opts({ runBaseline }));
    expect(res).toMatchObject({ kind: 'inconclusive', failingChecks: [] });
    expect(res.evidence).toEqual([expect.objectContaining({ checker: 'tests', cause: 'checker-error' })]);
    expect(res.reason).toContain('tests: the checker crashed before a verdict');
  });

  it('redacts a token in the evidence command and tail before it reaches the reason, the log or the result', async () => {
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const runBaseline = vi.fn<typeof runBaselineCheckers>(async () =>
      withCheckers([
        fail('tests', {
          baseDetails: `export GH_TOKEN=${secret}\nbash: tool: command not found`,
          baseCommand: { command: `run-tests --token=${secret}`, exitCode: 127, timeoutSeconds: 300 },
        }),
      ]),
    );
    const res = await checkBaseHealth(opts({ runBaseline }));
    expect(res.kind).toBe('inconclusive');
    expect(JSON.stringify(res)).not.toContain(secret);
    expect(messages().join('\n')).not.toContain(secret);
    expect(res.evidence?.[0]?.tail).toContain('command not found');
  });
});
