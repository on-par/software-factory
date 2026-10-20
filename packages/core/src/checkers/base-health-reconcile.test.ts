import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { EventKind } from '../events/kinds.js';
import type { ModelRouter } from '../router/index.js';
import type { CommandResult } from '../utils/command-runner.js';
import type { BaselineReport, runBaselineCheckers } from './baseline.js';
import { checkBaseHealth } from './base-health.js';

const SHA = 'b'.repeat(40);
const router = {} as ModelRouter;
const cmd = (): CommandResult => ({
  command: [],
  stdout: `${SHA}\n`,
  stderr: '',
  exitCode: 0,
  killed: false,
  timedOut: false,
  ok: true,
});

describe('base-health cached failure reconciliation', () => {
  let memo: Map<string, Promise<BaselineReport>>;
  let log: Mock<(type: EventKind, msg: string) => void>;

  beforeEach(() => {
    memo = new Map();
    log = vi.fn<(type: EventKind, msg: string) => void>();
  });

  function health(
    runBaseline: typeof runBaselineCheckers,
    requiredChecksVerdict: () => Promise<{ green: boolean; reason: string }>,
  ) {
    return checkBaseHealth({
      worktree: '/tmp/wt',
      constitution: null,
      router,
      env: { A: '1' },
      log,
      requiredChecksVerdict,
      deps: {
        runBaseline,
        memo,
        runCommand: vi.fn(async () => cmd()),
      },
    });
  }

  it('runs only cached failing checkers and accepts a fresh PASS', async () => {
    const runBaseline = vi
      .fn<typeof runBaselineCheckers>()
      .mockResolvedValueOnce({
        baseSha: SHA,
        checkers: [
          { checker: 'compile', verdict: 'clean-on-base', cached: true },
          { checker: 'lint', verdict: 'clean-on-base', cached: true },
          { checker: 'tests', verdict: 'fails-on-base', baseResult: 'FAIL', cached: true },
        ],
      })
      .mockResolvedValueOnce({
        baseSha: SHA,
        checkers: [{ checker: 'tests', verdict: 'clean-on-base', baseResult: 'PASS' }],
      });
    const ci = vi.fn(async () => ({ green: true, reason: 'push checks green' }));
    const result = await health(runBaseline, ci);
    expect(result).toMatchObject({ kind: 'green', failingChecks: [] });
    expect(runBaseline).toHaveBeenCalledTimes(2);
    expect(runBaseline.mock.calls[1][0]).toMatchObject({
      bypassCache: true,
      failing: [{ checker: 'tests', result: 'FAIL', details: '' }],
    });
    expect(ci).toHaveBeenCalledOnce();
  });

  it('confirms a fresh failure and logs one divergence for memo followers', async () => {
    const output = 'base still fails';
    const runBaseline = vi
      .fn<typeof runBaselineCheckers>()
      .mockResolvedValueOnce({
        baseSha: SHA,
        checkers: [{ checker: 'tests', verdict: 'fails-on-base', baseResult: 'FAIL', cached: true }],
      })
      .mockResolvedValueOnce({
        baseSha: SHA,
        checkers: [{ checker: 'tests', verdict: 'fails-on-base', baseResult: 'FAIL', baseDetails: output }],
      });
    const ci = vi.fn(async () => ({ green: true, reason: 'green' }));
    const first = await health(runBaseline, ci);
    const second = await health(runBaseline, ci);
    expect(first).toMatchObject({ kind: 'red', confirmedLocally: true, failingChecks: ['tests'] });
    expect(second).toMatchObject({ kind: 'red', confirmedLocally: true, failingChecks: ['tests'] });
    expect(runBaseline).toHaveBeenCalledTimes(2);
    expect(ci).toHaveBeenCalledOnce();
    expect(log.mock.calls.filter(([kind]) => kind === 'base_divergence')).toEqual([
      ['base_divergence', expect.stringContaining(`${SHA} checker tests still fails locally:\n${output}`)],
    ]);
  });
});
