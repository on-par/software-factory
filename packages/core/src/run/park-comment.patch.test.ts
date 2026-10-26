import { describe, expect, it } from 'vitest';
import { workKeyFromIssue } from '../work/work-key.js';
import {
  parkUnblockHint,
  patchParkComment,
  readParkState,
  renderParkComment,
  type ParkCommentInput,
} from './park-comment.js';

const K7 = workKeyFromIssue(7);

function input(overrides: Partial<ParkCommentInput> = {}): ParkCommentInput {
  return {
    issue: K7,
    reason: 'fail',
    message: 'checks failed',
    runId: 'run-1',
    branch: 'issue-7-x',
    lane: 'lane-a',
    parkSha: 'a'.repeat(40),
    blockers: [3, 4],
    ...overrides,
  };
}

describe('patchParkComment', () => {
  it('replaces the reason and the unblock hint', () => {
    const body = renderParkComment(input({ reason: 'blocked' }));
    const out = patchParkComment(body, K7, { reason: 'held' })!;
    expect(out).toContain('reason: held');
    expect(out).not.toContain('reason: blocked');
    expect(out).toContain(`**What unblocks this:** ${parkUnblockHint('held', K7)}`);
    expect(readParkState([{ id: 1, body: out }], K7)?.reason).toBe('held');
  });

  it('appends then replaces status and auto-unparks, leaving other lines alone', () => {
    const body = renderParkComment(input());
    const first = patchParkComment(body, K7, { status: 'resumed', autoUnparks: 1 })!;
    expect(first).toContain('status: resumed');
    expect(first).toContain('auto-unparks: 1');
    expect(first).toContain('branch: issue-7-x');
    const second = patchParkComment(first, K7, { status: 'held: a\nb', autoUnparks: 2 })!;
    expect(second.match(/^status:/gm)).toHaveLength(1);
    expect(second).toContain('status: held: a b');
    expect(second).toContain('auto-unparks: 2');
    expect(second).toContain('reason: fail');
    expect(second).toContain('**What unblocks this:** fix the failing');
  });

  it('tolerates a body with no hint line', () => {
    const body = renderParkComment(input()).replace(/\*\*What unblocks this:\*\*.*\n/, '');
    expect(patchParkComment(body, K7, { reason: 'held' })).toContain('reason: held');
  });

  it('returns null when there is no state block', () => {
    expect(patchParkComment('nothing here', K7, { status: 'x' })).toBeNull();
  });
});
