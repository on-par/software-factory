import { StorySchema } from '@on-par/contracts';
import type { Story } from '@on-par/contracts';
import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import type { SlicePlan } from '../readiness/slice-plan.js';
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
    createComment: vi.fn(async () => ({ data: { id: 9 } })),
  };
  const octokit = Object.assign({} as Octokit, {
    rest: { users: { getAuthenticated: async () => ({ data: { id: 1 } }) }, issues },
  });
  return { octokit, issues };
}

function run(key: WorkKey, ship: { prNumber?: number; alreadyDelivered?: boolean }) {
  const { octokit, issues } = fakeOctokit();
  const log = vi.fn();
  const result = recordShippedSlice({
    octokit,
    repo: 'o/r',
    key,
    branch: 'b',
    plan,
    index: 1,
    ship,
    stackMode: false,
    log,
  });
  return { result, issues, log };
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
});
