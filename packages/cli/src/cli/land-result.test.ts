import { describe, expect, it, vi } from 'vitest';

import { CiFailedError, CiInfraError, CiUnverifiedError, LandDeferredError } from './land-errors.js';
import { AwaitingCiError, AwaitingReviewError, LandConflictError, LandFailureError } from './land-pr.js';
import { landResultJsonSchema } from './land-result-contract.js';
import { LandNoOpenPrError, landResultKind, printLandResult, readLandResult } from './land-result.js';
import { BaseCiPendingError } from './merge-base-gate.js';
import { MergeGatedError } from './land-pr.js';

function fakeOctokit(
  over: { mergeable?: boolean | null; runs?: unknown[]; statuses?: unknown[]; fail?: boolean } = {},
) {
  const fail = over.fail === true;
  return {
    rest: {
      pulls: {
        get: vi.fn(async () => {
          if (fail) throw new Error('boom');
          return { data: { head: { sha: 'sha1' }, mergeable: over.mergeable ?? null } };
        }),
        list: vi.fn(async ({ head }: { head: string }) => {
          if (fail) throw new Error('boom');
          return { data: head.endsWith(':b2') ? [{ number: 9, merged_at: null }] : [] };
        }),
      },
      checks: {
        listForRef: vi.fn(async () => {
          if (fail) throw new Error('boom');
          return { data: { check_runs: over.runs ?? [] } };
        }),
      },
      repos: {
        getCombinedStatusForRef: vi.fn(async () => {
          if (fail) throw new Error('boom');
          return { data: { statuses: over.statuses ?? [] } };
        }),
      },
    },
  } as never;
}

describe('landResultKind', () => {
  it('maps a successful land to merged', () => {
    expect(landResultKind(undefined)).toBe('merged');
  });

  it('maps every CI-not-green error to checks_pending', () => {
    for (const err of [
      new CiUnverifiedError('x', 1),
      new LandDeferredError('x', 1, 'b'),
      new AwaitingCiError('x', 1, 'sha'),
      new BaseCiPendingError('x'),
    ]) {
      expect(landResultKind(err)).toBe('checks_pending');
    }
  });

  it('maps CiFailedError and CiInfraError to checks_failed', () => {
    expect(landResultKind(new CiFailedError('x', 1))).toBe('checks_failed');
    expect(landResultKind(new CiInfraError('x', 1))).toBe('checks_failed');
  });

  it('maps LandConflictError to conflicting', () => {
    expect(landResultKind(new LandConflictError('x'))).toBe('conflicting');
  });

  it('returns undefined for outcomes outside the five results', () => {
    for (const err of [
      new AwaitingReviewError('x', 1),
      new MergeGatedError('x', 1, 1, 'l'),
      new LandFailureError('x', 1),
      new Error('x'),
    ]) {
      expect(landResultKind(err)).toBeUndefined();
    }
  });
});

describe('readLandResult', () => {
  it('lists pending and failed check names from check runs and commit statuses', async () => {
    const octokit = fakeOctokit({
      runs: [
        { name: 'build', status: 'in_progress', conclusion: null },
        { name: 'lint', status: 'completed', conclusion: 'failure' },
        { name: 'ok', status: 'completed', conclusion: 'success' },
        { name: 'skip', status: 'completed', conclusion: 'skipped' },
      ],
      statuses: [
        { context: 'ci/a', state: 'pending' },
        { context: 'build', state: 'pending' },
        { context: 'ci/b', state: 'error' },
        { context: 'lint', state: 'failure' },
        { context: 'ci/c', state: 'success' },
      ],
    });
    const pending = await readLandResult(octokit, 'o/r', 'checks_pending', 3);
    expect(pending).toMatchObject({ result: 'checks_pending', pending: ['build', 'ci/a'] });
    expect(pending).not.toHaveProperty('failed');
    const failed = await readLandResult(octokit, 'o/r', 'checks_failed', 3);
    expect(failed).toMatchObject({ result: 'checks_failed', failed: ['ci/b', 'lint'] });
    expect(Object.keys(pending)).toEqual(['schemaVersion', 'result', 'pr', 'headSha', 'pending', 'mergeable']);
  });

  it('maps mergeable true, false and null to MERGEABLE, CONFLICTING and UNKNOWN', async () => {
    const got = [];
    for (const mergeable of [true, false, null]) {
      got.push((await readLandResult(fakeOctokit({ mergeable }), 'o/r', 'merged', 3)).mergeable);
    }
    expect(got).toEqual(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']);
  });

  it('falls back to a null headSha, UNKNOWN and empty lists when the reads fail', async () => {
    const res = await readLandResult(fakeOctokit({ fail: true }), 'o/r', 'checks_pending', 3);
    expect(res).toMatchObject({ headSha: null, mergeable: 'UNKNOWN', pending: [] });
  });
});

describe('printLandResult', () => {
  it('reports closed for LandNoOpenPrError when a closed PR exists on a guessed branch', async () => {
    const lines: string[] = [];
    await printLandResult({
      json: true,
      octokit: fakeOctokit(),
      ghRepo: 'o/r',
      error: new LandNoOpenPrError('none', ['b1', 'b2']),
      write: (l) => lines.push(l),
    });
    expect(lines).toHaveLength(1);
    expect(landResultJsonSchema.parse(JSON.parse(lines[0] as string))).toMatchObject({ result: 'closed', pr: 9 });
  });

  it('prints nothing when json is false', async () => {
    const lines: string[] = [];
    const write = (l: string) => void lines.push(l);
    await printLandResult({ json: false, octokit: fakeOctokit(), ghRepo: 'o/r', prNumber: 1, write });
    expect(lines).toEqual([]);
  });

  it('prints nothing without a PR number or for an unmapped error, and never rejects', async () => {
    const lines: string[] = [];
    const write = (l: string) => void lines.push(l);
    await printLandResult({ json: true, octokit: fakeOctokit(), ghRepo: 'o/r', write });
    await printLandResult({
      json: true,
      octokit: fakeOctokit(),
      ghRepo: 'o/r',
      prNumber: 1,
      error: new Error('x'),
      write,
    });
    await expect(
      printLandResult({
        json: true,
        octokit: fakeOctokit({ fail: true }),
        ghRepo: 'o/r',
        error: new LandNoOpenPrError('none', ['b1']),
        write,
      }),
    ).resolves.toBeUndefined();
    await expect(
      printLandResult({
        json: true,
        octokit: fakeOctokit({ fail: true }),
        ghRepo: 'o/r',
        prNumber: 1,
        write: () => {
          throw new Error('w');
        },
      }),
    ).resolves.toBeUndefined();
    expect(lines).toEqual([]);
  });
});
