import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { StorySchema } from '@on-par/contracts';
import type { Octokit } from '@octokit/rest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { renderSlicePlanComment } from './slice-plan.js';
import type { SlicePlan } from './slice-plan.js';
import { fileSlicePlanStore, issueCommentSlicePlanStore } from './slice-plan-store.js';

function plan(issue: number): SlicePlan {
  const story = StorySchema.parse({
    kind: 'story',
    schemaVersion: 1,
    title: 'Slice',
    role: 'a maintainer',
    want: 'a slice',
    soThat: 'it ships',
    problemStatement: 'too big',
    inScope: ['one thing'],
    outOfScope: [],
    acceptanceCriteria: [{ name: 'works', given: [], when: ['it runs'], then: ['it passes'] }],
    verification: [{ command: 'npm test', passWhen: 'green' }],
    filesLikelyTouched: [],
    labels: [],
    tracesTo: [],
  });
  return { issue, slices: [{ index: 1, title: 'Slice', story, state: 'pending' }] };
}

const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());
const tmp = (): Promise<string> => tempDirs.make('slice-plan-store-');

describe('fileSlicePlanStore', () => {
  it('round-trips a slice plan through its state file', async () => {
    const file = join(await tmp(), 'nested', 'slice-plans', '7.md');
    const store = fileSlicePlanStore(file);
    expect(await store.save(plan(7))).toEqual({ where: file });
    expect(await store.find()).toEqual({ status: 'found', plan: plan(7), where: file });
  });

  it('reports not-found for a missing file and invalid for unreadable data', async () => {
    const dir = await tmp();
    const file = join(dir, 'p.md');
    const store = fileSlicePlanStore(file);
    expect(await store.find()).toEqual({ status: 'not-found' });
    writeFileSync(file, 'garbage');
    expect(await store.find()).toMatchObject({ status: 'invalid', where: file });
    writeFileSync(file, renderSlicePlanComment(plan(7)).split('\n')[0] ?? '');
    expect(await store.find()).toMatchObject({ status: 'invalid', where: file });
  });

  it('propagates read errors other than a missing file', async () => {
    await expect(fileSlicePlanStore(await tmp()).find()).rejects.toThrow();
  });
});

describe('issueCommentSlicePlanStore', () => {
  it('reads and upserts the slice plan comment', async () => {
    const body = renderSlicePlanComment(plan(5));
    const listComments = vi.fn().mockResolvedValue({ data: [{ id: 55, user: { id: 1 }, body }] });
    const updateComment = vi.fn().mockResolvedValue({ data: {} });
    const octokit = Object.assign({} as Octokit, {
      rest: {
        users: { getAuthenticated: vi.fn().mockResolvedValue({ data: { id: 1 } }) },
        issues: { listComments, updateComment, createComment: vi.fn() },
      },
    });
    const store = issueCommentSlicePlanStore({ octokit, repo: 'acme/widgets', issue: 5 });
    expect(await store.find()).toEqual({ status: 'found', plan: plan(5), where: 'comment 55 on #5' });
    expect(await store.save(plan(5))).toEqual({ where: 'comment 55' });
    expect(updateComment).toHaveBeenCalledTimes(1);
  });

  it('maps an unreadable comment to invalid and a missing one to not-found', async () => {
    const make = (comments: unknown[]) =>
      issueCommentSlicePlanStore({
        octokit: Object.assign({} as Octokit, {
          rest: {
            users: { getAuthenticated: vi.fn().mockResolvedValue({ data: { id: 1 } }) },
            issues: { listComments: vi.fn().mockResolvedValue({ data: comments }) },
          },
        }),
        repo: 'acme/widgets',
        issue: 5,
      });
    expect(await make([]).find()).toEqual({ status: 'not-found' });
    const wrong = [{ id: 9, user: { id: 1 }, body: renderSlicePlanComment(plan(6)) }];
    expect(await make(wrong).find()).toMatchObject({ status: 'invalid', where: 'comment 9 on #5' });
  });
});
