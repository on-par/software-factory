// packages/cli/src/cli/run-issue-merge.test.ts — driveToMerge / exitForMerge / parseMergeTimeout (#3905)

import type { RunOutcome } from '@on-par/factory-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import './index.js';
import { CliExitError } from './errors.js';
import {
  AwaitingCiError,
  AwaitingReviewError,
  CiFailedError,
  CiInfraError,
  CiUnverifiedError,
  LandConflictError,
  LandFailureError,
  MergeGatedError,
  AwaitMergeStoppedError,
} from './land-pr.js';
import { BaseCiPendingError } from './merge-base-gate.js';
import { MERGE_EXIT, driveToMerge, exitForMerge, parseMergeTimeout } from './run-issue-merge.js';
import type { DriveToMergeInput } from './run-issue-merge.js';
import { validateMergeFlags } from './run-issue-merge.js';

const shipped: RunOutcome = {
  state: 'shipped',
  route: 'claude' as any,
  branch: 'ship-it/9-x',
  reworkRounds: 0,
  prNumber: 55,
};
const base = (over: Partial<DriveToMergeInput> = {}): DriveToMergeInput => ({
  issue: 9,
  outcome: shipped,
  repoRoot: '/repo',
  ghRepo: 'o/r',
  paths: {} as any,
  timeoutMs: 10_000,
  ...over,
});

function clock() {
  let t = 0;
  const sleep = vi.fn(async (ms: number) => {
    t += ms;
  });
  return { now: () => t, sleep };
}

/** The WaitForMergeDeps argument of the first waitMerge call. */
const depsOf = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls[0]?.[5];

afterEach(() => vi.restoreAllMocks());

describe('driveToMerge', () => {
  it('merges a green ungated PR and returns merged', async () => {
    const waitMerge = vi.fn(async () => {});
    const r = await driveToMerge(base(), { waitMerge });
    expect(r).toMatchObject({ kind: 'merged', prNumber: 55 });
    expect(depsOf(waitMerge)).toMatchObject({
      landBranch: 'ship-it/9-x',
      holdWhenGated: true,
      mergeOverrides: { auto: true },
    });
    expect((depsOf(waitMerge) as any).issueless).toBeUndefined();
  });

  it('a high-risk hold exits held and names the risk gate', async () => {
    const waitMerge = vi.fn(async () => {
      throw new AwaitingReviewError('held', 55, 'risk');
    });
    expect(await driveToMerge(base(), { waitMerge })).toMatchObject({ kind: 'held', gate: 'risk', prNumber: 55 });
  });

  it('a no-auto-merge label exits held immediately instead of polling', async () => {
    const { now, sleep } = clock();
    const waitMerge = vi.fn(async () => {
      throw new MergeGatedError('gated', 9, 55, 'no-auto-merge');
    });
    const r = await driveToMerge(base(), { waitMerge, now, sleep });
    expect(r).toMatchObject({ kind: 'held', gate: 'no-auto-merge', prNumber: 55 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('keeps the outcome PR number when the gate error has none', async () => {
    const waitMerge = vi.fn(async () => {
      throw new MergeGatedError('gated', 9, 0, 'needs-human');
    });
    expect(await driveToMerge(base(), { waitMerge })).toMatchObject({ kind: 'held', prNumber: 55 });
  });

  it('a draft PR exits held without landing', async () => {
    const waitMerge = vi.fn(async () => {});
    const outcome: RunOutcome = {
      state: 'ready',
      route: 'claude' as any,
      branch: 'b',
      reworkRounds: 0,
      prNumber: 5,
      draft: true,
    };
    expect(await driveToMerge(base({ outcome }), { waitMerge })).toMatchObject({
      kind: 'held',
      gate: 'draft',
      prNumber: 5,
    });
    expect(waitMerge).not.toHaveBeenCalled();
  });

  it('a non-final stack slice is held', async () => {
    const waitMerge = vi.fn(async () => {});
    const outcome: RunOutcome = {
      state: 'ready',
      route: 'claude' as any,
      branch: 'b',
      reworkRounds: 0,
      slice: { index: 1, count: 3 },
    };
    expect(await driveToMerge(base({ outcome }), { waitMerge })).toMatchObject({ kind: 'held', gate: 'stack-slice' });
    expect(waitMerge).not.toHaveBeenCalled();
  });

  it('lands a ready outcome on its last slice', async () => {
    const waitMerge = vi.fn(async () => {});
    const outcome: RunOutcome = {
      state: 'ready',
      route: 'claude' as any,
      branch: 'b',
      reworkRounds: 0,
      prNumber: 6,
      slice: { index: 3, count: 3 },
    };
    expect(await driveToMerge(base({ outcome }), { waitMerge })).toMatchObject({ kind: 'merged', prNumber: 6 });
  });

  it('red CI exits ci-failed and never merges even with admin', async () => {
    const waitMerge = vi.fn(async () => {
      throw new CiFailedError('red', 55);
    });
    const r = await driveToMerge(base({ admin: true }), { waitMerge });
    expect(r).toMatchObject({ kind: 'ci-failed', prNumber: 55 });
    expect(depsOf(waitMerge)).toMatchObject({ mergeOverrides: { auto: true, admin: true } });
  });

  it('CiInfraError is ci-failed too', async () => {
    const waitMerge = vi.fn(async () => {
      throw new CiInfraError('infra', 55);
    });
    expect((await driveToMerge(base(), { waitMerge })).kind).toBe('ci-failed');
  });

  it('a ci-failed park after SHIP CI rework exits ci-failed', async () => {
    const waitMerge = vi.fn(async () => {});
    for (const reason of ['ci-failed', 'ci-infra'] as const) {
      const outcome: RunOutcome = { state: 'parked', reason, prNumber: 8 };
      expect(await driveToMerge(base({ outcome }), { waitMerge })).toMatchObject({ kind: 'ci-failed', prNumber: 8 });
    }
    const noPr: RunOutcome = { state: 'parked', reason: 'ci-failed' };
    expect((await driveToMerge(base({ outcome: noPr }), { waitMerge })).prNumber).toBeUndefined();
    expect(waitMerge).not.toHaveBeenCalled();
  });

  it('a park before any PR exits failed-before-pr without landing', async () => {
    const waitMerge = vi.fn(async () => {});
    const parked: RunOutcome = { state: 'parked', reason: 'escalate' };
    const withPr: RunOutcome = { state: 'parked', reason: 'conflict', prNumber: 4 };
    const failed: RunOutcome = { state: 'escalated' } as any;
    const released: RunOutcome = { state: 'released', reason: 'environment' } as any;
    for (const outcome of [undefined, parked, failed, released]) {
      expect((await driveToMerge(base({ outcome }), { waitMerge })).kind).toBe('failed-before-pr');
    }
    const r = await driveToMerge(base({ outcome: withPr }), { waitMerge });
    expect(r).toMatchObject({ kind: 'failed-before-pr', prNumber: 4 });
    expect(r.detail).toContain('conflict');
    expect(waitMerge).not.toHaveBeenCalled();
  });

  it('a ready outcome without a branch is failed-before-pr', async () => {
    const outcome: any = { state: 'ready', route: 'claude', reworkRounds: 0 };
    expect((await driveToMerge(base({ outcome }), { waitMerge: vi.fn() })).kind).toBe('failed-before-pr');
  });

  it('CI still pending at the deadline exits timed-out', async () => {
    const { now, sleep } = clock();
    const waitMerge = vi.fn(async () => {
      throw new AwaitingCiError('pending', 55, 'sha');
    });
    const r = await driveToMerge(base({ timeoutMs: 150_000 }), { waitMerge, now, sleep, pollMs: 60_000 });
    expect(r.kind).toBe('timed-out');
    expect(waitMerge).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it('retries on unverified CI and base CI pending, then merges', async () => {
    const { now, sleep } = clock();
    const waitMerge = vi
      .fn()
      .mockRejectedValueOnce(new CiUnverifiedError('u', 55))
      .mockRejectedValueOnce(new BaseCiPendingError('b'))
      .mockResolvedValueOnce(undefined);
    expect((await driveToMerge(base({ timeoutMs: 600_000 }), { waitMerge, now, sleep })).kind).toBe('merged');
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it('abort and timeout errors are timed-out', async () => {
    for (const name of ['TimeoutError', 'AbortError']) {
      const waitMerge = vi.fn(async () => {
        throw Object.assign(new Error('x'), { name });
      });
      expect((await driveToMerge(base(), { waitMerge })).kind).toBe('timed-out');
    }
  });

  it('a signal aborted by the deadline classifies as timed-out', async () => {
    const waitMerge = vi.fn(async (...args: any[]) => {
      const signal = args[5].signal as AbortSignal;
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error(`aborted=${signal.aborted}`);
    });
    const r = await driveToMerge(base({ timeoutMs: 1 }), { waitMerge });
    expect(r.kind).toBe('timed-out');
  });

  it('land conflict and every other error are land-failed', async () => {
    for (const err of [
      new LandConflictError('conflict'),
      new LandFailureError('boom', 5),
      new AwaitMergeStoppedError('stop', 'b', 5),
      new Error('other'),
    ]) {
      const waitMerge = vi.fn(async () => {
        throw err;
      });
      const r = await driveToMerge(base(), { waitMerge });
      expect(r.kind).toBe('land-failed');
      expect(r.detail).toContain(err.message);
    }
  });

  it('forwards issueless for briefs', async () => {
    const waitMerge = vi.fn(async () => {});
    await driveToMerge(base({ issueless: true }), { waitMerge });
    expect(depsOf(waitMerge)).toMatchObject({ issueless: true });
  });

  it('defaults the deadline to the caller-supplied cap (ci.awaitingCiCapHours)', async () => {
    const { now, sleep } = clock();
    const capMs = 3 * 3_600_000;
    const waitMerge = vi.fn(async () => {
      throw new AwaitingCiError('pending', 55, 'sha');
    });
    await driveToMerge(base({ timeoutMs: capMs }), { waitMerge, now, sleep, pollMs: 3_600_000 });
    expect(waitMerge).toHaveBeenCalledTimes(4);
  });
});

describe('parseMergeTimeout', () => {
  it('parseMergeTimeout accepts s m h and rejects malformed values', () => {
    expect(parseMergeTimeout(undefined)).toBeUndefined();
    expect(parseMergeTimeout('90s')).toBe(90_000);
    expect(parseMergeTimeout('30m')).toBe(1_800_000);
    expect(parseMergeTimeout('2h')).toBe(7_200_000);
    for (const bad of ['', '0m', '5', 'm', '-5m', '1.5h', '2d', '10 m']) {
      const err = (() => {
        try {
          parseMergeTimeout(bad);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(CliExitError);
      expect((err as CliExitError).code).toBe(2);
    }
  });
});

describe('exitForMerge', () => {
  it('exitForMerge does not throw for merged', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => exitForMerge({ kind: 'merged', prNumber: 5, detail: 'merged' }, 'issue #9')).not.toThrow();
    expect(log.mock.calls[0]?.[0]).toContain('merged PR #5 for issue #9');
    exitForMerge({ kind: 'merged', detail: 'merged' }, 'brief');
  });

  it('maps every non-merged kind to its code and names the gate and PR', () => {
    const cases = [
      [{ kind: 'held', gate: 'risk', prNumber: 5, detail: 'd' }, 10],
      [{ kind: 'ci-failed', detail: 'd' }, 11],
      [{ kind: 'timed-out', detail: 'd' }, 12],
      [{ kind: 'land-failed', detail: 'd' }, 13],
      [{ kind: 'failed-before-pr', detail: 'd' }, 1],
    ] as const;
    for (const [result, code] of cases) {
      const err = (() => {
        try {
          exitForMerge(result, 'issue #9');
        } catch (e) {
          return e as CliExitError;
        }
      })();
      expect(err?.code).toBe(code);
      expect(err?.message.startsWith(`factory: issue #9 not merged (${result.kind})`)).toBe(true);
    }
    expect(() => exitForMerge(cases[0][0], 'x')).toThrow(/held by risk PR #5/);
  });

  it('MERGE_EXIT codes are pairwise distinct and avoid the usage code', () => {
    const codes = Object.values(MERGE_EXIT);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).not.toContain(2);
  });
});

describe('validateMergeFlags', () => {
  it('passes without --merge and parses the timeout with it', () => {
    expect(validateMergeFlags({})).toBeUndefined();
    expect(validateMergeFlags({ merge: true, mergeTimeout: '2h' })).toBe(7_200_000);
  });
  it.each([
    [{ mergeTimeout: '1h' }, /need --merge/],
    [{ admin: true }, /need --merge/],
    [{ merge: true, pr: false }, /needs a PR/],
    [{ merge: true, workspace: 'w' }, /--workspace/],
    [{ merge: true, stack: true }, /--stack/],
    [{ merge: true, mergeTimeout: 'soon' }, /positive duration/],
  ])('rejects %j', (flags, msg) => {
    expect(() => validateMergeFlags(flags)).toThrow(msg);
  });
});
