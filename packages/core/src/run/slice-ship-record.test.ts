import { StorySchema } from '@on-par/contracts';
import type { Story } from '@on-par/contracts';
import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import type { SlicePlan } from '../readiness/slice-plan.js';
import { parseSlicePlanComment } from '../readiness/slice-plan.js';
import { toWorkKey, workKeyFromIssue, type WorkKey } from '../work/work-key.js';
import { recordShippedSlice } from './slice-ship-record.js';

function story(title: string): Story {
  return StorySchema.parse({
    kind: 'story',
    schemaVersion: 1,
    title,
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
}

const plan: SlicePlan = {
  issue: 42,
  slices: [
    { index: 1, title: 'one', story: story('one'), state: 'pending' },
    { index: 2, title: 'two', story: story('two'), state: 'pending' },
  ],
};

function fakeOctokit() {
  const issues = {
    listComments: vi.fn(async () => ({ data: [] })),
    createComment: vi.fn(async (a: { body: string }) => ({ data: { id: 9, body: a.body } })),
  };
  const octokit = Object.assign({} as Octokit, {
    rest: { users: { getAuthenticated: async () => ({ data: { id: 1 } }) }, issues },
  });
  return { octokit, issues };
}

const HEAD = 'a'.repeat(40);

type ShipStub = { prNumber?: number; alreadyDelivered?: boolean; headSha?: string };

function run(key: WorkKey, ship: ShipStub, readHeadSha = vi.fn(async () => HEAD)) {
  const { octokit, issues } = fakeOctokit();
  const log = vi.fn();
  const result = recordShippedSlice({
    octokit,
    repo: 'o/r',
    key,
    branch: 'b',
    worktree: '/wt',
    plan,
    index: 1,
    ship,
    stackMode: false,
    readHeadSha,
    log,
  });
  return { result, issues, log, readHeadSha };
}

function savedPlan(issues: ReturnType<typeof fakeOctokit>['issues']): SlicePlan {
  const body = issues.createComment.mock.calls[0]![0].body;
  const parsed = parseSlicePlanComment(body);
  if (parsed?.ok !== true) throw new Error('slice plan comment unreadable');
  return parsed.plan;
}

describe('recordShippedSlice', () => {
  it('writes the slice plan comment on the numeric issue of the key', async () => {
    const { result, issues, log } = run(workKeyFromIssue(42), { prNumber: 7 });
    expect(await result).toBeUndefined();
    expect(issues.listComments).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'o', repo: 'r', issue_number: 42 }),
    );
    expect(issues.createComment).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 42 }));
    expect(log).toHaveBeenCalledWith('ship', expect.stringContaining('recorded slice 1/2 as pr-open (PR #7'));
  });

  it('logs and returns undefined when the ship has no PR number', async () => {
    const { result, issues, log } = run(workKeyFromIssue(42), {});
    expect(await result).toBeUndefined();
    expect(issues.createComment).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('ship', expect.stringContaining('no PR number'));
  });

  it('returns the failure message for a non-numeric key without touching GitHub', async () => {
    const { result, issues } = run(toWorkKey('PROJ-1'), { prNumber: 7 });
    expect(await result).toContain('recording it in the slice plan comment failed');
    expect(issues.listComments).not.toHaveBeenCalled();
  });

  function runWithStore(save: () => Promise<{ where: string }>) {
    const { octokit, issues } = fakeOctokit();
    const log = vi.fn();
    const result = recordShippedSlice({
      octokit,
      repo: 'o/r',
      key: toWorkKey('brief-1'),
      branch: 'b',
      worktree: '/wt',
      plan,
      index: 1,
      ship: { prNumber: 7 },
      stackMode: false,
      readHeadSha: vi.fn(async () => HEAD),
      store: { find: vi.fn(), save },
      log,
    });
    return { result, issues, log };
  }

  it('saves through an injected store, leaves GitHub comments alone and logs the slice plan file', async () => {
    const save = vi.fn(async () => ({ where: 'plan.md' }));
    const { result, issues, log } = runWithStore(save);
    expect(await result).toBeUndefined();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ slices: expect.any(Array) }));
    expect(issues.createComment).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('ship', expect.stringMatching(/in the slice plan file$/));
  });

  it('names the slice plan file when saving to an injected store fails', async () => {
    const { result } = runWithStore(async () => {
      throw new Error('disk full');
    });
    expect(await result).toBe('slice 1/2 PR #7 opened but recording it in the slice plan file failed: disk full');
  });

  it('names the slice plan comment in the issue log line', async () => {
    const { result, log } = run(workKeyFromIssue(42), { prNumber: 7 });
    await result;
    expect(log).toHaveBeenCalledWith('ship', expect.stringMatching(/in the slice plan comment$/));
  });

  it('records the head SHA the ship reported for an opened slice', async () => {
    const { result, issues, readHeadSha } = run(workKeyFromIssue(42), { prNumber: 7, headSha: HEAD });
    expect(await result).toBeUndefined();
    expect(savedPlan(issues).slices[0]!.headSha).toBe(HEAD);
    expect(readHeadSha).not.toHaveBeenCalled();
  });

  it('falls back to the worktree HEAD when the ship reported no head SHA', async () => {
    const readHeadSha = vi.fn(async () => 'b'.repeat(40));
    const { result, issues } = run(workKeyFromIssue(42), { prNumber: 7 }, readHeadSha);
    expect(await result).toBeUndefined();
    expect(savedPlan(issues).slices[0]!.headSha).toBe('b'.repeat(40));
    expect(readHeadSha).toHaveBeenCalledWith('/wt');
  });

  it('returns a failure message and writes nothing when the head SHA cannot be read', async () => {
    const readHeadSha = vi.fn(async () => {
      throw new Error('boom');
    });
    const { result, issues } = run(workKeyFromIssue(42), { prNumber: 7 }, readHeadSha);
    expect(await result).toBe('slice 1/2 PR #7 opened but its head SHA could not be read: boom');
    expect(issues.createComment).not.toHaveBeenCalled();
  });

  it('records a merged slice without reading a head SHA', async () => {
    const { result, issues, readHeadSha } = run(workKeyFromIssue(42), { prNumber: 7, alreadyDelivered: true });
    expect(await result).toBeUndefined();
    const slice = savedPlan(issues).slices[0]!;
    expect(slice.state).toBe('merged');
    expect(slice.headSha).toBeUndefined();
    expect(readHeadSha).not.toHaveBeenCalled();
  });
});
