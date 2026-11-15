import { StorySchema } from '@on-par/contracts';
import type { Story } from '@on-par/contracts';
import type { Octokit } from '@octokit/rest';
import { describe, expect, it } from 'vitest';

import type { EventKind } from '../events/kinds.js';
import type { SlicePlan } from '../readiness/slice-plan.js';
import type { SlicePlanStore } from '../readiness/slice-plan-store.js';
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

type Comment = { issue_number: number; body: string };

function fakeOctokit() {
  const listed: unknown[] = [];
  const created: Comment[] = [];
  const issues = {
    listComments: async (a: unknown) => (listed.push(a), { data: [] }),
    createComment: async (a: Comment) => (created.push(a), { data: { id: 9, body: a.body } }),
  };
  const octokit = Object.assign({} as Octokit, {
    rest: { users: { getAuthenticated: async () => ({ data: { id: 1 } }) }, issues },
  });
  return { octokit, listed, created };
}

const HEAD = 'a'.repeat(40);

type ShipStub = { prNumber?: number; alreadyDelivered?: boolean; headSha?: string };

function fakeLog() {
  const logs: Array<[string, string]> = [];
  return { logs, log: (type: EventKind, msg: string) => void logs.push([type, msg]) };
}

function run(
  key: WorkKey,
  ship: ShipStub,
  impl: (wt: string) => Promise<string> = async () => HEAD,
  store?: SlicePlanStore,
) {
  const { octokit, listed, created } = fakeOctokit();
  const { logs, log } = fakeLog();
  const reads: string[] = [];
  const readHeadSha = async (wt: string) => (reads.push(wt), impl(wt));
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
    store,
    log,
  });
  return { result, listed, created, logs, reads };
}

function savedPlan(created: Comment[]): SlicePlan {
  const parsed = parseSlicePlanComment(created[0]!.body);
  if (parsed?.ok !== true) throw new Error('slice plan comment unreadable');
  return parsed.plan;
}

describe('recordShippedSlice', () => {
  it('writes the slice plan comment on the numeric issue of the key', async () => {
    const { result, listed, created, logs } = run(workKeyFromIssue(42), { prNumber: 7 });
    expect(await result).toBeUndefined();
    expect(listed).toEqual([expect.objectContaining({ owner: 'o', repo: 'r', issue_number: 42 })]);
    expect(created.map((c) => c.issue_number)).toEqual([42]);
    expect(logs).toContainEqual(['ship', expect.stringContaining('recorded slice 1/2 as pr-open (PR #7')]);
    expect(logs).toContainEqual(['ship', expect.stringMatching(/in the slice plan comment$/)]);
  });

  it('logs and returns undefined when the ship has no PR number', async () => {
    const { result, logs } = run(workKeyFromIssue(42), {});
    expect(await result).toBeUndefined();
    expect(logs).toEqual([['ship', expect.stringContaining('no PR number')]]);
  });

  it('returns the failure message for a non-numeric key without touching GitHub', async () => {
    const { result, listed } = run(toWorkKey('PROJ-1'), { prNumber: 7 });
    expect(await result).toContain('recording it in the slice plan comment failed');
    expect(listed).toEqual([]);
  });

  function runWithStore(save: () => Promise<{ where: string }>) {
    const saved: SlicePlan[] = [];
    const store = {
      find: async () => ({ status: 'not-found' as const }),
      save: async (p: SlicePlan) => (saved.push(p), save()),
    };
    return { ...run(toWorkKey('brief-1'), { prNumber: 7 }, undefined, store), saved };
  }

  it('saves through an injected store, leaves GitHub comments alone and logs the slice plan file', async () => {
    const { result, created, logs, saved } = runWithStore(async () => ({ where: 'plan.md' }));
    expect(await result).toBeUndefined();
    expect(saved.map((p) => p.slices[0])).toEqual([expect.objectContaining({ state: 'pr-open', prNumber: 7 })]);
    expect(created).toEqual([]);
    expect(logs).toContainEqual(['ship', expect.stringMatching(/in the slice plan file$/)]);
  });

  it('names the slice plan file when saving to an injected store fails', async () => {
    const { result } = runWithStore(() => Promise.reject(new Error('disk full')));
    expect(await result).toBe('slice 1/2 PR #7 opened but recording it in the slice plan file failed: disk full');
  });

  it('records the head SHA the ship reported for an opened slice', async () => {
    const { result, created, reads } = run(workKeyFromIssue(42), { prNumber: 7, headSha: HEAD });
    expect(await result).toBeUndefined();
    expect(savedPlan(created).slices[0]!.headSha).toBe(HEAD);
    expect(reads).toEqual([]);
  });

  it('falls back to the worktree HEAD when the ship reported no head SHA', async () => {
    const { result, created, reads } = run(workKeyFromIssue(42), { prNumber: 7 }, async () => 'b'.repeat(40));
    expect(await result).toBeUndefined();
    expect(savedPlan(created).slices[0]!.headSha).toBe('b'.repeat(40));
    expect(reads).toEqual(['/wt']);
  });

  it('returns a failure message and writes nothing when the head SHA cannot be read', async () => {
    const { result, created } = run(workKeyFromIssue(42), { prNumber: 7 }, () => Promise.reject(new Error('boom')));
    expect(await result).toBe('slice 1/2 PR #7 opened but its head SHA could not be read: boom');
    expect(created).toEqual([]);
  });

  it('records a merged slice without reading a head SHA', async () => {
    const { result, created, reads } = run(workKeyFromIssue(42), { prNumber: 7, alreadyDelivered: true });
    expect(await result).toBeUndefined();
    const slice = savedPlan(created).slices[0]!;
    expect(slice.state).toBe('merged');
    expect(slice.headSha).toBeUndefined();
    expect(reads).toEqual([]);
  });
});
