// packages/cli/src/cli/run-lane-land-park-comment.test.ts — a park raised after runIssue (land error, preflight) upserts the issue park comment (#3534)

import {
  PARKED_LABEL,
  pollBlockedParks,
  publishParkComment,
  type QueueGitHubClient,
} from '@on-par/factory-core/internal';
import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import { LaneParkError } from './index.js';
import { CiInfraError, CiUnverifiedError, LandConflictError } from './land-pr.js';
import { runLane } from './run-lane.js';

const paths: any = { events: '/repo/.factory/events.ndjson', stop: '/repo/.factory/STOP' };
const N = 3534;

type Stored = { id: number; body: string; user: { id: number } };

function fakeOctokit(seed: Stored[]) {
  const comments = [...seed];
  let rejecting = false;
  const updateComment = vi.fn(async (a: { comment_id: number; body: string }) => {
    if (rejecting) throw new Error('github 502');
    const hit = comments.find((c) => c.id === a.comment_id);
    if (hit) hit.body = a.body;
    return {};
  });
  const createComment = vi.fn(async (a: { body: string }) => {
    if (rejecting) throw new Error('github 502');
    comments.push({ id: 100 + comments.length, body: a.body, user: { id: 1 } });
    return { data: { id: 100 + comments.length } };
  });
  const listComments = vi.fn(async () => ({ data: comments }));
  const octokit = Object.assign({} as Octokit, {
    rest: {
      users: { getAuthenticated: async () => ({ data: { id: 1 } }) },
      issues: { listComments, updateComment, createComment },
    },
    paginate: async (fn: (a: unknown) => Promise<{ data: unknown[] }>, a: unknown) => (await fn(a)).data,
  });
  return { octokit, reject: () => (rejecting = true), comments, updateComment, createComment, listComments };
}

const marker = `<!-- factory-issue-state v1 issue:${N} -->`;
const stateLine = (comments: Stored[], key: string): string | undefined =>
  new RegExp(`^${key}: (.*)$`, 'm').exec(comments[0]?.body ?? '')?.[1];

// Seed the older park's comment through the real publisher so it is a genuine marked comment (id 42).
async function seedComment(reason: 'fail' | 'blocked', fake: ReturnType<typeof fakeOctokit>): Promise<void> {
  await publishParkComment({
    octokit: fake.octokit,
    repo: 'on-par/software-factory',
    readHead: async () => '228c2401',
    worktree: '/repo',
    input: { issue: N, reason, message: 'old', runId: 'r0', branch: 'old' },
  });
  fake.comments[0].id = 42;
  fake.updateComment.mockClear();
  fake.createComment.mockClear();
}

async function park(err: Error, fake: ReturnType<typeof fakeOctokit>, ship?: (c: any) => void) {
  const events: { kind: string; message: string }[] = [];
  const releaseIssue = vi.fn(async () => {});
  await runLane('app', [N], '/repo', 'on-par/software-factory', paths, {
    ship: async (_i, _o, ctx) => {
      ship?.(ctx);
      return `factory/${N}-x`;
    },
    waitMerge: async () => {
      throw err;
    },
    octokit: () => fake.octokit,
    readParkSha: async () => 'abc123',
    releaseIssue,
    emitEvent: ((_p: string, kind: string, _i: unknown, message: string) => {
      events.push({ kind, message });
    }) as any,
    pathExists: () => false,
  });
  return { events, releaseIssue };
}

describe('land-time park comment', () => {
  it('a land-time ci-failed park upserts the issue park comment', async () => {
    const fake = fakeOctokit([]);
    await seedComment('fail', fake);
    await park(new CiUnverifiedError('CI unverified', 353), fake);
    expect(stateLine(fake.comments, 'reason')).toBe('ci-failed');
    expect(stateLine(fake.comments, 'branch')).toBe(`factory/${N}-x`);
    expect(stateLine(fake.comments, 'park-sha')).toBe('abc123');
    expect(fake.updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 42 }));
    expect(fake.createComment).not.toHaveBeenCalled();
    expect(fake.comments).toHaveLength(1);
  });

  it.each([
    [new CiInfraError('infra', 353), 'ci-infra'],
    [new LandConflictError('conflict'), 'conflict'],
  ])(
    'a land-time ci-infra or conflict park with no prior comment creates one marked comment (%s)',
    async (err, reason) => {
      const fake = fakeOctokit([]);
      await park(err, fake);
      expect(fake.createComment).toHaveBeenCalledTimes(1);
      const body = fake.createComment.mock.calls[0][0].body;
      expect(body).toContain(marker);
      expect(stateLine(fake.comments, 'reason')).toBe(reason);
    },
  );

  it('a rejected park comment write still parks and logs a warning', async () => {
    const fake = fakeOctokit([]);
    await seedComment('fail', fake);
    fake.reject();
    const { events, releaseIssue } = await park(new CiUnverifiedError('CI unverified', 353), fake);
    expect(releaseIssue).toHaveBeenCalledWith(N, 'parked');
    expect(events.some((e) => e.kind === 'parked')).toBe(true);
    expect(events.some((e) => e.kind === 'warn' && e.message.includes('could not post the issue park comment'))).toBe(
      true,
    );
  });

  it('a land-time ci-failed park over a stale blocked comment makes pollBlockedParks skip the issue', async () => {
    const fake = fakeOctokit([]);
    await seedComment('blocked', fake);
    await park(new CiUnverifiedError('CI unverified', 353), fake);
    const listBlockedBy = vi.fn(async () => []);
    const client = Object.assign({} as QueueGitHubClient, {
      listOpenIssuesWithLabels: async () => [{ number: N, labels: [PARKED_LABEL] }],
    });
    const store = {
      readParkComment: async () => fake.comments[0],
      updateComment: async () => {},
      listBlockedBy,
      blockerEvidence: async () => ({ factoryFiled: false, mergedClosingPr: false }),
    };
    const out = await pollBlockedParks({ client, owner: 'on-par', repo: 'software-factory', store });
    expect(out).toEqual([{ issue: N, outcome: 'skipped', detail: 'reason ci-failed' }]);
    expect(listBlockedBy).not.toHaveBeenCalled();
  });

  it('a runIssue park does not write the comment twice', async () => {
    const fake = fakeOctokit([]);
    const events: string[] = [];
    await runLane('app', [N], '/repo', 'on-par/software-factory', paths, {
      ship: async (_i, _o, ctx) => {
        ctx?.onOutcome?.({ state: 'parked', reason: 'fail' } as any);
        throw new LaneParkError('x', 'fail');
      },
      octokit: () => fake.octokit,
      emitEvent: ((_p: string, kind: string) => {
        events.push(kind);
      }) as any,
      pathExists: () => false,
    });
    expect(events).toContain('parked');
    expect(fake.listComments).not.toHaveBeenCalled();
    expect(fake.updateComment).not.toHaveBeenCalled();
    expect(fake.createComment).not.toHaveBeenCalled();
  });
});
