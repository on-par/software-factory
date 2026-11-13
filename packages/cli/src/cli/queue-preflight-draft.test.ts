import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StackPullReviews } from '@on-par/factory-core/internal';
import { claimIterateCommand, createFileIterateStore } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';

import { preflightQueuedIssue } from './index.js';
import {
  classifyFactoryDraft,
  makeDraftAdoptionOps,
  type DraftAdoptionOps,
  type FactoryDraftFacts,
} from './queue-preflight-draft.js';

const baseDeps = {
  expectedHeadRepoFullName: 'on-par/software-factory',
  findOpenPR: async () => ({
    number: 71,
    branch: 'factory/7-x',
    headSha: 'abc123',
    headRepoFullName: 'on-par/software-factory',
  }),
  getLandState: async () => ({ isDraft: true, mergeStateStatus: 'BLOCKED' }),
  watch: async () => 'success' as const,
  findSlicePlan: async () => ({ status: 'not-found' as const }),
  getPullState: async () => 'open' as const,
  saveSlicePlan: async () => {},
  autoMergeStack: false,
  stackMode: false,
  getPullReviews: async (): Promise<StackPullReviews> => Promise.reject(new Error('unexpected review lookup')),
  readIssueBody: async () => '',
  getMergedClosingPr: async () => undefined,
  getPrerequisiteState: async () => {
    throw new Error('unexpected prerequisite lookup');
  },
  getPullRefs: async () => ({ headRef: 'b', baseRef: 'main', headSha: 's' }),
  branchContains: async () => false,
  ciPendingDraft: async () => false,
};

const parked = { kind: 'park', reason: 'PR #71 is draft or its draft state is unavailable' };

function fakeOps(over: Partial<Record<keyof DraftAdoptionOps, unknown>> = {}) {
  return {
    classify: vi.fn(async () => 'factory' as const),
    probeCi: vi.fn(async () => 'success' as const),
    queueCiRework: vi.fn(async () => {}),
    ...over,
  };
}

const run = (draftAdoption: unknown, overrides: Record<string, unknown> = {}) =>
  preflightQueuedIssue({ number: 7, labels: [] }, { ...baseDeps, draftAdoption, ...overrides } as any);

describe('factory draft adoption (#4039)', () => {
  it('adopts a factory draft with no draftReason and green CI', async () => {
    const ops = fakeOps();
    await expect(run(ops)).resolves.toEqual({ kind: 'adopt', branch: 'factory/7-x' });
    expect(ops.queueCiRework).not.toHaveBeenCalled();
  });

  it('queues CI rework for an unparked ci-failed draft instead of parking it as draft', async () => {
    const ops = fakeOps({ probeCi: vi.fn(async () => 'failure' as const) });
    await expect(run(ops)).resolves.toEqual({ kind: 'build' });
    expect(ops.queueCiRework).toHaveBeenCalledWith(7, 71);
  });

  it('adopts a factory draft with pending CI so land watches CI', async () => {
    for (const outcome of ['timeout', 'no-checks'] as const) {
      const ops = fakeOps({ probeCi: vi.fn(async () => outcome) });
      await expect(run(ops)).resolves.toEqual({ kind: 'adopt', branch: 'factory/7-x' });
    }
  });

  it('parks a requested draft as today without probing CI', async () => {
    const ops = fakeOps({ classify: vi.fn(async () => 'requested' as const) });
    await expect(run(ops)).resolves.toEqual(parked);
    expect(ops.probeCi).not.toHaveBeenCalled();
  });

  it('parks a draft whose head is not a factory commit as today', async () => {
    const ops = fakeOps({ classify: vi.fn(async () => 'not-factory' as const) });
    await expect(run(ops)).resolves.toEqual(parked);
    expect(ops.probeCi).not.toHaveBeenCalled();
  });

  it('parks as today when the draft classification fails', async () => {
    const ops = fakeOps({ classify: vi.fn(async () => Promise.reject(new Error('boom'))) });
    await expect(run(ops)).resolves.toEqual(parked);
  });

  it('parks as today when no draftAdoption ops are supplied', async () => {
    await expect(run(undefined)).resolves.toEqual(parked);
  });

  it('defers when the CI probe or the rework queue fails', async () => {
    const onDeferred = vi.fn();
    const probeFails = fakeOps({ probeCi: vi.fn(async () => Promise.reject(new Error('net'))) });
    await expect(run(probeFails, { onDeferred })).resolves.toEqual({ kind: 'defer' });
    expect(onDeferred).toHaveBeenCalledTimes(1);

    const queueFails = fakeOps({
      probeCi: vi.fn(async () => 'failure' as const),
      queueCiRework: vi.fn(async () => Promise.reject(new Error('disk'))),
    });
    await expect(run(queueFails, { onDeferred })).resolves.toEqual({ kind: 'defer' });
    expect(onDeferred).toHaveBeenCalledTimes(2);
  });

  it('keeps the ci-pending path ahead of the new adoption', async () => {
    const ops = fakeOps();
    await expect(run(ops, { ciPendingDraft: async () => true })).resolves.toEqual({
      kind: 'adopt',
      branch: 'factory/7-x',
    });
    expect(ops.classify).not.toHaveBeenCalled();
  });
});

describe('classifyFactoryDraft', () => {
  const self = { id: 5, login: 'f', kind: 'user' as const };
  const facts = (over: Partial<FactoryDraftFacts> = {}): FactoryDraftFacts => ({
    issue: 7,
    prNumber: 71,
    branch: 'factory/7-x',
    branchPrefix: 'factory',
    draftMode: false,
    runState: { status: 'none', ignored: [] } as any,
    prAuthor: { id: 5 },
    headAuthor: { id: 5 },
    self,
    ...over,
  });
  const found = (state: Record<string, unknown>) =>
    ({ status: 'found', commentId: 1, state: { prNumber: 71, ...state }, ignored: [] }) as any;

  it('classifyFactoryDraft treats a parked run-state with no draftReason as factory', () => {
    expect(classifyFactoryDraft(facts({ runState: found({ status: 'parked' }) }))).toBe('factory');
    expect(classifyFactoryDraft(facts())).toBe('factory');
    expect(classifyFactoryDraft(facts({ headAuthor: null }))).toBe('factory');
  });

  it('classifyFactoryDraft treats a requested run-state or draft-PR mode as requested', () => {
    expect(classifyFactoryDraft(facts({ runState: found({ draftReason: 'requested' }) }))).toBe('requested');
    expect(classifyFactoryDraft(facts({ draftMode: true }))).toBe('requested');
  });

  it('classifyFactoryDraft rejects a head commit authored by another account', () => {
    expect(classifyFactoryDraft(facts({ headAuthor: { id: 9 } }))).toBe('not-factory');
    expect(classifyFactoryDraft(facts({ prAuthor: { id: 9 } }))).toBe('not-factory');
    expect(classifyFactoryDraft(facts({ branch: 'factory/8-x' }))).toBe('not-factory');
    expect(classifyFactoryDraft(facts({ branch: 'feature/x' }))).toBe('not-factory');
    expect(classifyFactoryDraft(facts({ runState: found({ prNumber: 70 }) }))).toBe('not-factory');
  });
});

describe('makeDraftAdoptionOps', () => {
  const opts = (iterateFile: string) => ({
    branchPrefix: 'factory',
    draftMode: false,
    iterateFile,
    probeCi: async () => 'success' as const,
    now: () => new Date('2026-11-13T00:00:00Z'),
  });

  it('queueCiRework records an iterate run that the next ship claims', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'draft-adopt-')), 'iterate.json');
    await makeDraftAdoptionOps({} as any, 'o', 'r', opts(file)).queueCiRework(7, 71);
    const claimed = claimIterateCommand(createFileIterateStore(file), 7);
    expect(claimed).toMatchObject({ pr: 71, issue: 7, actor: 'factory-queue-preflight' });
    expect(claimed!.commentId).toBeLessThan(0);
  });

  it('makeDraftAdoptionOps().classify reads the run state, PR author and head commit author', async () => {
    const octokit: any = {
      rest: {
        users: { getAuthenticated: async () => ({ data: { id: 5, login: 'f' } }) },
        issues: { listComments: async () => ({ data: [] }) },
        pulls: { get: async () => ({ data: { user: { id: 5 } } }) },
        repos: { getCommit: async () => ({ data: { author: { id: 5 } } }) },
      },
      paginate: async () => [],
    };
    const ops = makeDraftAdoptionOps(octokit, 'o', 'r', opts('unused'));
    const pr = { number: 71, branch: 'factory/7-x', headSha: 'abc123', headRepoFullName: 'o/r' };
    await expect(ops.classify(7, pr)).resolves.toBe('factory');
  });
});
