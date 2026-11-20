import { styleText } from 'node:util';

import type { Octokit } from '@octokit/rest';
import { afterEach, describe, expect, it } from 'vitest';

import { landJsonSchema } from './land-contract.js';
import { CiFailedError, CiUnverifiedError } from './land-errors.js';
import {
  AwaitingCiError,
  AwaitingReviewError,
  LandConflictError,
  LandFailureError,
  MergeGatedError,
} from './land-pr.js';
import { landReporter, NoOpenPrError } from './land-result.js';

type PrData = { mergeable?: boolean | null; state?: string };
type World = { pr?: PrData; prError?: boolean; checksError?: boolean; runs?: unknown[]; branchPrs?: unknown[] };

function octokitFor(world: World): Octokit {
  return {
    rest: {
      pulls: {
        get: async () => {
          if (world.prError) throw new Error('pull lookup failed');
          return { data: { head: { sha: 'abc123' }, mergeable: null, state: 'open', ...world.pr } };
        },
        list: async () => ({ data: world.branchPrs ?? [] }),
      },
      checks: {
        listForRef: async () => {
          if (world.checksError) throw new Error('checks lookup failed');
          return { data: { check_runs: world.runs ?? [] } };
        },
      },
    },
  } as never;
}

const runs = [
  { name: 'static', status: 'completed', conclusion: 'success' },
  { name: 'e2e', status: 'in_progress', conclusion: null },
  { name: 'unit', status: 'completed', conclusion: 'failure' },
];

async function report(err: unknown, world: World = {}, opts: { json?: boolean; knownPr?: number } = {}) {
  const printed: string[] = [];
  const reporter = landReporter(
    { octokit: octokitFor(world), ghRepo: 'acme/widgets', issue: 5, json: opts.json ?? true },
    (line) => void printed.push(line),
  );
  if (opts.knownPr !== undefined) reporter.onPr(opts.knownPr);
  let outcome: { code: number; message: string | undefined };
  try {
    await reporter.failed(err);
    outcome = { code: typeof process.exitCode === 'number' ? process.exitCode : 0, message: undefined };
  } catch (thrown) {
    const failure = thrown as { code: number; message: string };
    outcome = { code: failure.code, message: failure.message };
  }
  const last = printed.at(-1) ?? '';
  return { ...outcome, printed, json: last.startsWith('{') ? landJsonSchema.parse(JSON.parse(last)) : null };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe('land result reporting', () => {
  it('reports merged on a successful land, exits 0 and prints the success line first', async () => {
    const printed: string[] = [];
    const reporter = landReporter(
      { octokit: octokitFor({ pr: { state: 'closed' }, runs }), ghRepo: 'acme/widgets', issue: 5, json: true },
      (line) => void printed.push(line),
    );
    await reporter.landed(77);
    expect(printed[0]).toBe(styleText('green', '✅ Landed PR #77 for issue #5'));
    expect(JSON.parse(printed[1]!)).toEqual({
      result: 'merged',
      pr: 77,
      headSha: 'abc123',
      pending: ['e2e'],
      mergeable: 'UNKNOWN',
      schemaVersion: 1,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('reports checks_pending and exits 75 when the CI watch timed out without a green verdict', async () => {
    const err = new CiUnverifiedError('CI watch ended timeout', 77);
    const res = await report(err, { pr: { mergeable: true }, runs }, { knownPr: 77 });
    expect(res.code).toBe(75);
    expect(res.message).toBeUndefined();
    expect(res.printed[0]).toBe(
      styleText('yellow', '⏸ PR #77 for issue #5 — CI never reached a green verdict — left open, not merged'),
    );
    expect(res.printed.at(-1)).toBe(
      '{"result":"checks_pending","pr":77,"headSha":"abc123","pending":["e2e"],"mergeable":"MERGEABLE","schemaVersion":1}',
    );
  });

  it('falls back to the awaited head SHA and UNKNOWN when the PR cannot be read', async () => {
    const res = await report(new AwaitingCiError('no CI yet', 77, 'def456'), { prError: true }, { knownPr: 77 });
    expect(res.code).toBe(75);
    expect(res.json).toEqual({
      result: 'checks_pending',
      pr: 77,
      headSha: 'def456',
      pending: [],
      mergeable: 'UNKNOWN',
      schemaVersion: 1,
    });
  });

  it('reports checks_failed with the failing checks and keeps the exit-0 left-open handling', async () => {
    const res = await report(new CiFailedError('CI failed', 77), { pr: { mergeable: true }, runs }, { knownPr: 77 });
    expect(res.code).toBe(0);
    expect(res.printed[0]).toBe(
      styleText('yellow', '⏸ PR #77 for issue #5 has a failing CI check — left open, not merged'),
    );
    expect(res.json).toEqual({
      result: 'checks_failed',
      pr: 77,
      headSha: 'abc123',
      failed: ['unit'],
      mergeable: 'MERGEABLE',
      schemaVersion: 1,
    });
  });

  it('reports empty check lists when the PR or its checks cannot be read', async () => {
    const unreadablePr = await report(new CiFailedError('red', 77), { prError: true }, { knownPr: 77 });
    expect(unreadablePr.json).toMatchObject({ headSha: null, failed: [], mergeable: 'UNKNOWN' });
    const unreadableChecks = await report(new CiFailedError('red', 77), { checksError: true, runs }, { knownPr: 77 });
    expect(unreadableChecks.json).toMatchObject({ headSha: 'abc123', failed: [] });
  });

  it('reports conflicting and keeps exit 3 with the same error message', async () => {
    const err = new LandConflictError('issue #5: conflict rounds exhausted — parked');
    const res = await report(err, { pr: { mergeable: false } }, { knownPr: 77 });
    expect(res.code).toBe(3);
    expect(res.message).toBe('factory: issue #5: conflict rounds exhausted — parked');
    expect(res.json).toMatchObject({ result: 'conflicting', pr: 77, mergeable: 'CONFLICTING', pending: [] });
  });

  it('reports closed for an already-closed PR and keeps the no-open-PR exit 1', async () => {
    const closed = [{ number: 76, merged_at: null }];
    const res = await report(new NoOpenPrError(5, 'factory/5-fix'), { pr: { state: 'closed' }, branchPrs: closed });
    expect(res.code).toBe(1);
    expect(res.message).toBe('factory: no open PR for issue #5 (factory/5-fix)');
    expect(res.json).toMatchObject({ result: 'closed', pr: 76, headSha: 'abc123' });
  });

  it('reports closed when the PR was closed while landing, keeping the merge-failed exit 5', async () => {
    const res = await report(new Error('not mergeable'), { pr: { state: 'closed' } }, { knownPr: 77 });
    expect(res.code).toBe(5);
    expect(res.message).toBe('factory: merge failed for issue #5: not mergeable');
    expect(res.json).toMatchObject({ result: 'closed', pr: 77 });
  });

  it('prints no result line when there is no PR or the outcome is not a land result', async () => {
    const merged = [{ number: 76, merged_at: '2026-11-20T00:00:00Z' }];
    expect(await report(new NoOpenPrError(5, 'factory/5-fix'), { branchPrs: merged })).toMatchObject({
      code: 1,
      printed: [],
    });
    const review = await report(new AwaitingReviewError('awaiting review', 77), {}, { knownPr: 77 });
    expect(review).toMatchObject({ code: 0, json: null });
    expect(review.printed).toEqual([styleText('yellow', '⏸ PR #77 for issue #5 awaiting human review — left open')]);
    const gated = await report(new MergeGatedError('gated', 5, 77, 'no-auto-merge'), {}, { knownPr: 77 });
    expect(gated).toMatchObject({ code: 4, message: 'factory: gated', printed: [] });
    expect(await report(new LandFailureError('lookup failed', 5), {}, { knownPr: 77 })).toMatchObject({ code: 5 });
  });

  it('keeps human output and exit codes unchanged without --json', async () => {
    const pending = await report(new CiUnverifiedError('timeout', 77), { prError: true }, { json: false });
    expect(pending.code).toBe(75);
    expect(pending.printed).toEqual([
      styleText('yellow', '⏸ PR #77 for issue #5 — CI never reached a green verdict — left open, not merged'),
    ]);
    const conflict = await report(new LandConflictError('conflict'), { pr: { state: 'closed' } }, { json: false });
    expect(conflict).toMatchObject({ code: 3, message: 'factory: conflict', printed: [] });
  });
});
