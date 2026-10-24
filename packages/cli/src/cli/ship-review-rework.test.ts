// packages/cli/src/cli/ship-review-rework.test.ts — ship claims a queued review rework or `/factory iterate` record for the issue (#3564, #3625).
import { join } from 'node:path';

import { createFileIterateStore, createFileReviewReworkStore } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claimIterateRequest, claimReviewReworkRequest, claimReworkRequests } from './ship-review-rework.js';

const tmp = createTempDirs();
let dir: string;
let paths: { reviewRework: string; iterate: string };
beforeEach(() => {
  dir = tmp.makeSync('ship-rework-');
  paths = { reviewRework: join(dir, 'review.json'), iterate: join(dir, 'iterate.json') };
});
afterEach(() => tmp.cleanup());

const queueIterate = () =>
  createFileIterateStore(paths.iterate).record({
    commentId: 9,
    pr: 7,
    issue: 42,
    actor: 'alice',
    seenAt: '2026-01-01T00:00:00.000Z',
    outcome: 'queued',
  });
const queueReview = () =>
  createFileReviewReworkStore(paths.reviewRework).record({
    reviewId: 3,
    pr: 7,
    issue: 42,
    lane: 'bugfix',
    reviewer: 'bob',
    queuedAt: '2026-01-01T00:00:00.000Z',
  });

describe('claimIterateRequest', () => {
  it('claims a queued iterate once and logs it', () => {
    queueIterate();
    const log = vi.fn();
    expect(claimIterateRequest(paths.iterate, 42, false, log)).toEqual({
      iterate: { prNumber: 7, commentId: 9, actor: 'alice' },
    });
    expect(log).toHaveBeenCalledWith('rework', expect.stringContaining('iterate of PR #7 by @alice (comment 9)'));
    expect(claimIterateRequest(paths.iterate, 42, false, log)).toEqual({});
  });

  it('claims nothing when skipped or for another issue', () => {
    queueIterate();
    expect(claimIterateRequest(paths.iterate, 42, true, vi.fn())).toEqual({});
    expect(claimIterateRequest(paths.iterate, 43, false, vi.fn())).toEqual({});
  });
});

describe('claimReworkRequests', () => {
  it('a review rework wins and leaves the iterate record pending', () => {
    queueReview();
    queueIterate();
    const claim = claimReworkRequests(paths, 42, false, vi.fn());
    expect(claim).toEqual({ reviewRework: { prNumber: 7, reviewId: 3, reviewer: 'bob' } });
    expect(claimIterateRequest(paths.iterate, 42, false, vi.fn())).toHaveProperty('iterate');
  });

  it('falls back to iterate, and claims nothing when skipped', () => {
    queueIterate();
    expect(claimReworkRequests(paths, 42, true, vi.fn())).toEqual({});
    expect(claimReworkRequests(paths, 42, false, vi.fn())).toHaveProperty('iterate');
  });

  it('claimReviewReworkRequest still claims on its own', () => {
    queueReview();
    expect(claimReviewReworkRequest(paths.reviewRework, 42, false, vi.fn())).toHaveProperty('reviewRework');
  });
});
