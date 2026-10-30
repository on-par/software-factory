import { StorySchema } from '@on-par/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { Slice, SlicePlan } from '../readiness/slice-plan.js';
import { readReviewApproval, readStackSliceGate } from './stack-approval.js';
import type { StackPullReviews, StackSliceGateReader, StackSliceReview } from './stack-approval.js';

const review = (reviewerId: number | null, state: string, commitId: string | null = 'head'): StackSliceReview => ({
  reviewerId,
  state,
  commitId,
});
const pull = (...reviews: StackSliceReview[]): StackPullReviews => ({ headSha: 'head', selfId: 1, reviews });

describe('readReviewApproval', () => {
  it('reads an approval on the head commit as approved', () => {
    expect(readReviewApproval(pull(review(2, 'APPROVED')))).toBe('approved');
  });
  it('does not count an approval on an older commit', () => {
    expect(readReviewApproval(pull(review(2, 'APPROVED', 'old')))).toBe('waiting');
    expect(readReviewApproval(pull(review(2, 'APPROVED', null)))).toBe('waiting');
  });
  it('lets a later CHANGES_REQUESTED supersede an approval', () => {
    expect(readReviewApproval(pull(review(2, 'APPROVED'), review(2, 'CHANGES_REQUESTED')))).toBe('changes-requested');
  });
  it('lets a later approval supersede CHANGES_REQUESTED from the same reviewer', () => {
    expect(readReviewApproval(pull(review(2, 'CHANGES_REQUESTED'), review(2, 'APPROVED')))).toBe('approved');
  });
  it('blocks when another reviewer has outstanding CHANGES_REQUESTED', () => {
    expect(readReviewApproval(pull(review(2, 'APPROVED'), review(3, 'CHANGES_REQUESTED')))).toBe('changes-requested');
  });
  it('ignores the factory identity and deleted accounts', () => {
    expect(readReviewApproval(pull(review(1, 'APPROVED'), review(null, 'APPROVED')))).toBe('waiting');
  });
  it('keeps an approval through a later COMMENTED review', () => {
    expect(readReviewApproval(pull(review(2, 'APPROVED'), review(2, 'COMMENTED'), review(2, 'PENDING')))).toBe(
      'approved',
    );
  });
  it('clears CHANGES_REQUESTED on DISMISSED', () => {
    expect(readReviewApproval(pull(review(2, 'CHANGES_REQUESTED'), review(2, 'DISMISSED')))).toBe('waiting');
  });
  it('waits on an empty review list', () => {
    expect(readReviewApproval(pull())).toBe('waiting');
  });
});

const storyStub = StorySchema.parse({
  kind: 'story',
  schemaVersion: 1,
  title: 'slice',
  role: 'a maintainer',
  want: 'a slice',
  soThat: 'it ships',
  problemStatement: 'the issue is too big',
  inScope: ['one thing'],
  outOfScope: [],
  acceptanceCriteria: [{ name: 'works', given: [], when: ['it runs'], then: ['it passes'] }],
  verification: [{ command: 'npm test', passWhen: 'green' }],
  filesLikelyTouched: [],
  labels: [],
  tracesTo: [],
});

const slice = (index: number, state: Slice['state'], prNumber?: number): Slice => ({
  index,
  title: `s${index}`,
  story: storyStub,
  state,
  ...(prNumber === undefined ? {} : { prNumber }),
});
const planOf = (...slices: Slice[]): SlicePlan => ({ issue: 7, slices });
const readerOf = (state: 'open' | 'merged' | 'closed', reviews: StackPullReviews = pull()) =>
  ({
    getPullState: vi.fn(async () => state),
    getPullReviews: vi.fn(async () => reviews),
  }) satisfies StackSliceGateReader;

describe('readStackSliceGate', () => {
  it('picks the highest pr-open or merged slice', async () => {
    const reader = readerOf('open', pull(review(2, 'APPROVED')));
    const plan = planOf(slice(1, 'merged', 10), slice(2, 'pr-open', 11), slice(3, 'pending'));
    await expect(readStackSliceGate(plan, reader)).resolves.toEqual({ status: 'approved', index: 2, prNumber: 11 });
    expect(reader.getPullState).toHaveBeenCalledWith(11);
  });
  it('does not read an approval on an older commit or one superseded by CHANGES_REQUESTED as approved', async () => {
    const plan = planOf(slice(1, 'pr-open', 10), slice(2, 'pending'));
    await expect(readStackSliceGate(plan, readerOf('open', pull(review(2, 'APPROVED', 'old'))))).resolves.toMatchObject(
      { status: 'waiting' },
    );
    await expect(
      readStackSliceGate(plan, readerOf('open', pull(review(2, 'APPROVED'), review(2, 'CHANGES_REQUESTED')))),
    ).resolves.toMatchObject({ status: 'changes-requested' });
  });
  it('reads a merged slice from the plan without API calls', async () => {
    const reader = readerOf('open');
    await expect(readStackSliceGate(planOf(slice(1, 'merged', 10), slice(2, 'pending')), reader)).resolves.toEqual({
      status: 'merged',
      index: 1,
      prNumber: 10,
    });
    expect(reader.getPullState).not.toHaveBeenCalled();
    expect(reader.getPullReviews).not.toHaveBeenCalled();
  });
  it('reads a PR that merged on GitHub as merged', async () => {
    await expect(
      readStackSliceGate(planOf(slice(1, 'pr-open', 10), slice(2, 'pending')), readerOf('merged')),
    ).resolves.toMatchObject({ status: 'merged' });
  });
  it('waits on a closed PR', async () => {
    const reader = readerOf('closed');
    await expect(readStackSliceGate(planOf(slice(1, 'pr-open', 10)), reader)).resolves.toMatchObject({
      status: 'waiting',
    });
    expect(reader.getPullReviews).not.toHaveBeenCalled();
  });
  it('returns none when no slice is built', async () => {
    await expect(
      readStackSliceGate(planOf(slice(1, 'pending'), slice(2, 'not-built')), readerOf('open')),
    ).resolves.toEqual({
      status: 'none',
    });
  });
  it('throws when a pr-open slice records no PR number', async () => {
    await expect(readStackSliceGate(planOf(slice(1, 'pr-open')), readerOf('open'))).rejects.toThrow(/no PR number/);
  });
});
