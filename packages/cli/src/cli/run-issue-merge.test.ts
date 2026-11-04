// packages/cli/src/cli/run-issue-merge.test.ts — run-issue --merge result classification and exit codes (#3905)

import { afterEach, describe, expect, it, vi } from 'vitest';

import './index.js';
import { CliExitError } from './errors.js';
import {
  AwaitMergeStoppedError,
  AwaitingCiError,
  AwaitingReviewError,
  CiFailedError,
  CiInfraError,
  CiUnverifiedError,
  LandConflictError,
  LandFailureError,
  MergeGatedError,
} from './land-pr.js';
import { BaseCiPendingError } from './merge-base-gate.js';
import {
  MERGE_EXIT,
  type DriveToMergeInput,
  driveToMerge,
  exitForMerge,
  parseMergeTimeout,
} from './run-issue-merge.js';

const route = { provider: 'p', model: 'm' } as any;
const shipped = { state: 'shipped', route, branch: 'ship-it/9-x', reworkRounds: 0, prNumber: 55 } as const;

const input = (extra: Partial<DriveToMergeInput> = {}): DriveToMergeInput => ({
  issue: 9,
  outcome: shipped,
  repoRoot: '/repo',
  ghRepo: 'o/r',
  paths: {} as any,
  timeoutMs: 60_000,
  ...extra,
});

afterEach(() => vi.restoreAllMocks());

describe('driveToMerge', () => {
  it('merges a green ungated PR and returns merged', async () => {
    const waitMerge = vi.fn(async () => {});
    const result = await driveToMerge(input(), { waitMerge });
    expect(result).toMatchObject({ kind: 'merged', prNumber: 55 });
    expect(waitMerge.mock.calls[0]?.[0]).toBe(9);
    expect(waitMerge.mock.calls[0]?.[1]).toBe('ship-it/9-x');
    const deps = waitMerge.mock.calls[0]?.[5] as any;
    expect(deps).toMatchObject({ landBranch: 'ship-it/9-x', holdWhenGated: true, mergeOverrides: { auto: true } });
    expect(deps.mergeOverrides.admin).toBeUndefined();
    expect(deps.issueless).toBeUndefined();
    expect(deps.signal).toBeInstanceOf(AbortSignal);
  });

  it('forwards issueless for briefs', async () => {
    const waitMerge = vi.fn(async () => {});
    await driveToMerge(input({ issueless: true }), { waitMerge });
    expect((waitMerge.mock.calls[0]?.[5] as any).issueless).toBe(true);
  });

  it('a high-risk hold exits held and names the risk gate', async () => {
    const waitMerge = vi.fn(async () => {
      throw new AwaitingReviewError('PR #55 held', 55, 'risk');
    });
    const result = await driveToMerge(input(), { waitMerge });
    expect(result).toMatchObject({ kind: 'held', gate: 'risk', prNumber: 55 });
    expect(() => exitForMerge(result, 'issue #9')).toThrow(/not merged \(held\) held by risk \(PR #55\)/);
  });

  it('a no-auto-merge label exits held immediately instead of polling', async () => {
    const sleep = vi.fn(async () => {});
    const waitMerge = vi.fn(async () => {
      throw new MergeGatedError('gated', 9, 0, 'no-auto-merge');
    });
    const result = await driveToMerge(input(), { waitMerge, sleep });
    expect(result).toMatchObject({ kind: 'held', gate: 'no-auto-merge', prNumber: 55 });
    expect(sleep).not.toHaveBeenCalled();
    expect(waitMerge).toHaveBeenCalledTimes(1);
  });

  it('a draft PR exits held without landing', async () => {
    const waitMerge = vi.fn();
    const outcome = { state: 'ready', route, branch: 'b', reworkRounds: 0, prNumber: 3, draft: true } as const;
    expect(await driveToMerge(input({ outcome }), { waitMerge })).toMatchObject({ kind: 'held', gate: 'draft' });
    expect(waitMerge).not.toHaveBeenCalled();
  });

  it('a non-final stack slice exits held', async () => {
    const outcome = { state: 'ready', route, branch: 'b', reworkRounds: 0, slice: { index: 1, count: 3 } } as const;
    expect(await driveToMerge(input({ outcome }), { waitMerge: vi.fn() })).toMatchObject({
      kind: 'held',
      gate: 'stack-slice',
    });
  });

  it('red CI exits ci-failed and never merges even with admin', async () => {
    const waitMerge = vi.fn(async () => {
      throw new CiFailedError('red', 55);
    });
    const result = await driveToMerge(input({ admin: true }), { waitMerge });
    expect(result).toMatchObject({ kind: 'ci-failed', prNumber: 55 });
    expect((waitMerge.mock.calls[0]?.[5] as any).mergeOverrides).toEqual({ auto: true, admin: true });
    expect(() => exitForMerge(result, 'x')).toThrow(expect.objectContaining({ code: MERGE_EXIT.ciFailed }));
  });

  it('CiInfraError is ci-failed too', async () => {
    const waitMerge = vi.fn(async () => {
      throw new CiInfraError('infra', 55);
    });
    expect((await driveToMerge(input(), { waitMerge })).kind).toBe('ci-failed');
  });

  it('a ci-failed park after SHIP CI rework exits ci-failed', async () => {
    const outcome = { state: 'parked', reason: 'ci-failed', prNumber: 8 } as const;
    const waitMerge = vi.fn();
    expect(await driveToMerge(input({ outcome }), { waitMerge })).toMatchObject({ kind: 'ci-failed', prNumber: 8 });
    expect(waitMerge).not.toHaveBeenCalled();
    const infra = { state: 'parked', reason: 'ci-infra' } as const;
    expect((await driveToMerge(input({ outcome: infra }), { waitMerge })).kind).toBe('ci-failed');
  });

  it('a park before any PR exits failed-before-pr without landing', async () => {
    const waitMerge = vi.fn();
    const outcomes: any[] = [
      undefined,
      { state: 'parked', reason: 'fail' },
      { state: 'parked', reason: 'escalate', prNumber: 4 },
      { state: 'released', reason: 'environment' },
      { state: 'escalated', reason: 'why' },
      { state: 'ready', route, branch: '', reworkRounds: 0 },
    ];
    for (const outcome of outcomes) {
      const result = await driveToMerge(input({ outcome }), { waitMerge });
      expect(result.kind).toBe('failed-before-pr');
    }
    const withPr = await driveToMerge(input({ outcome: outcomes[2] }), { waitMerge });
    expect(withPr).toMatchObject({ prNumber: 4 });
    expect(withPr.detail).toContain('escalate');
    expect(waitMerge).not.toHaveBeenCalled();
  });

  it('CI still pending at the deadline exits timed-out', async () => {
    let t = 0;
    const sleep = vi.fn(async (ms: number) => {
      t += ms;
    });
    const errors = [new AwaitingCiError('pending', 55, 'sha'), new CiUnverifiedError('unk', 55), new BaseCiPendingError()];
    let n = 0;
    const waitMerge = vi.fn(async () => {
      throw errors[n++ % 3];
    });
    const result = await driveToMerge(input({ timeoutMs: 150 }), { waitMerge, now: () => t, sleep, pollMs: 100 });
    expect(result).toMatchObject({ kind: 'timed-out', prNumber: 55 });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(waitMerge).toHaveBeenCalledTimes(3);
  });

  it('retries a pending CI until it turns green', async () => {
    let calls = 0;
    const waitMerge = vi.fn(async () => {
      if (++calls < 2) throw new AwaitingCiError('pending', 55, 'sha');
    });
    const result = await driveToMerge(input(), { waitMerge, now: () => 0, sleep: async () => {} });
    expect(result.kind).toBe('merged');
  });

  it('an aborted wait exits timed-out', async () => {
    const named = Object.assign(new Error('t'), { name: 'TimeoutError' });
    expect((await driveToMerge(input(), { waitMerge: vi.fn().mockRejectedValue(named) })).kind).toBe('timed-out');
    const abort = Object.assign(new Error('a'), { name: 'AbortError' });
    expect((await driveToMerge(input(), { waitMerge: vi.fn().mockRejectedValue(abort) })).kind).toBe('timed-out');
  });

  it('classifies conflicts and other failures as land-failed', async () => {
    const errs = [
      new LandConflictError('conflict', 55, 'b', ['a'], 'DIRTY' as any),
      new AwaitMergeStoppedError('stop', 'b', 55),
      new LandFailureError('nope', 5),
      new Error('boom'),
    ];
    for (const e of errs) {
      const result = await driveToMerge(input(), { waitMerge: vi.fn().mockRejectedValue(e) });
      expect(result.kind).toBe('land-failed');
    }
  });

  it('defaults the deadline to the caller-supplied timeout', async () => {
    const waitMerge = vi.fn(async () => {
      throw new AwaitingCiError('pending', 55, 'sha');
    });
    const result = await driveToMerge(input({ timeoutMs: 0 }), { waitMerge, now: () => 5, sleep: vi.fn() });
    expect(result.kind).toBe('timed-out');
    expect(waitMerge).toHaveBeenCalledTimes(1);
  });
});

describe('parseMergeTimeout', () => {
  it('parseMergeTimeout accepts s m h and rejects malformed values', () => {
    expect(parseMergeTimeout(undefined)).toBeUndefined();
    expect(parseMergeTimeout('90s')).toBe(90_000);
    expect(parseMergeTimeout('30m')).toBe(1_800_000);
    expect(parseMergeTimeout('2h')).toBe(7_200_000);
    for (const bad of ['', '0m', '1d', 'abc', '-5m', '1.5h', '30']) {
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
    expect(() => exitForMerge({ kind: 'merged', prNumber: 55, detail: 'merged' }, 'issue #9')).not.toThrow();
    expect(log.mock.calls[0]?.[0]).toContain('merged PR #55 for issue #9');
  });

  it('maps each non-merged kind to its code', () => {
    const code = (kind: any) => {
      try {
        exitForMerge({ kind, detail: 'd' }, 'issue #9');
      } catch (e) {
        return (e as CliExitError).code;
      }
    };
    expect(code('failed-before-pr')).toBe(1);
    expect(code('held')).toBe(10);
    expect(code('ci-failed')).toBe(11);
    expect(code('timed-out')).toBe(12);
    expect(code('land-failed')).toBe(13);
  });

  it('MERGE_EXIT codes are pairwise distinct and avoid the usage code', () => {
    const codes = Object.values(MERGE_EXIT);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).not.toContain(2);
  });
});
