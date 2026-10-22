import { describe, expect, it, vi } from 'vitest';

import { claimExpiresLabel, CLAIMED_BY_LABEL_PREFIX, DECOMPOSED_LABEL, PARKED_LABEL } from '../queue/github-queue.js';
import { claimOf, dispositionOf, existenceOf, fetchIssueRecord, type IssueRecord } from './worktree-gc-issues.js';
import { IssueWarnDedup } from './worktree-gc-types.js';

const ok = (labels: string[], state = 'open'): IssueRecord => ({ kind: 'ok', state, labels });
const claimed = `${CLAIMED_BY_LABEL_PREFIX}host:1`;
const expiredLease = claimExpiresLabel(Math.floor(Date.now() / 1000) - 3600);

describe('dispositionOf', () => {
  it.each([
    ['closed', ok([], 'closed'), 'reap-closed'],
    ['claimed', ok([claimed]), 'keep-claimed'],
    ['claimed with lapsed lease', ok([claimed, expiredLease]), 'keep'],
    ['parked', ok([PARKED_LABEL]), 'reap-parked'],
    ['decomposed', ok([DECOMPOSED_LABEL]), 'reap-decomposed'],
    ['plain', ok([]), 'keep'],
    ['not-found', { kind: 'not-found', message: 'x' } as IssueRecord, null],
    ['error', { kind: 'error', message: 'x' } as IssueRecord, null],
    ['not-configured', { kind: 'not-configured' } as IssueRecord, null],
  ])('%s', (_n, record, expected) => {
    expect(dispositionOf(record, 5)).toBe(expected);
  });
});

describe('existenceOf', () => {
  it.each([
    [ok([]), 'exists'],
    [{ kind: 'not-found', message: 'x' } as IssueRecord, 'not-found'],
    [{ kind: 'error', message: 'x' } as IssueRecord, 'error'],
    [{ kind: 'not-configured' } as IssueRecord, 'not-configured'],
  ])('maps %j', (record, expected) => {
    expect(existenceOf(record)).toBe(expected);
  });
});

describe('claimOf', () => {
  it.each([
    ['no label', ok([]), 'unclaimed'],
    ['live claim', ok([claimed]), 'claimed'],
    ['expired lease', ok([claimed, expiredLease]), 'unclaimed'],
    ['error', { kind: 'error', message: 'x' } as IssueRecord, 'unknown'],
    ['not-configured', { kind: 'not-configured' } as IssueRecord, 'unknown'],
  ])('%s', (_n, record, expected) => {
    expect(claimOf(record, 5)).toBe(expected);
  });
});

describe('fetchIssueRecord', () => {
  const octokitWith = (get: ReturnType<typeof vi.fn>) => ({ rest: { issues: { get } } }) as never;

  it('calls issues.get once and maps string and object labels', async () => {
    const get = vi.fn().mockResolvedValue({ data: { state: 'open', labels: ['a', { name: 'b' }, {}] } });
    const record = await fetchIssueRecord(octokitWith(get), 'o/r', 5, vi.fn(), new IssueWarnDedup());
    expect(record).toEqual({ kind: 'ok', state: 'open', labels: ['a', 'b', ''] });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('returns not-configured without a client or repo', async () => {
    expect(await fetchIssueRecord(undefined, 'o/r', 5, vi.fn(), new IssueWarnDedup())).toEqual({
      kind: 'not-configured',
    });
    expect(await fetchIssueRecord(octokitWith(vi.fn()), undefined, 5, vi.fn(), new IssueWarnDedup())).toEqual({
      kind: 'not-configured',
    });
  });

  it('maps a 404 to not-found and any other failure to error, warning each time', async () => {
    const log = vi.fn();
    const notFound = vi.fn().mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    expect(await fetchIssueRecord(octokitWith(notFound), 'o/r', 5, log, new IssueWarnDedup())).toEqual({
      kind: 'not-found',
      message: 'Not Found',
    });
    const limited = vi.fn().mockRejectedValue(Object.assign(new Error('rate limit'), { status: 403 }));
    expect(await fetchIssueRecord(octokitWith(limited), 'o/r', 6, log, new IssueWarnDedup())).toEqual({
      kind: 'error',
      message: 'rate limit',
    });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][1]).toContain('GitHub issue query failed for #5 (Not Found)');
  });
});
