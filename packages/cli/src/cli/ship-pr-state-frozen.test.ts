// packages/cli/src/cli/ship-pr-state-frozen.test.ts — an in-place run resumes on a fresh clone with its frozen plan from the PR (#4025)
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { defaultFactoryConfig } from '@on-par/factory-config';
import type { Octokit } from '@octokit/rest';
import { workKeyFromIssue, type EventKind } from '@on-par/factory-core';
import { createTempDirs, loadReusablePlan } from '@on-par/factory-core/testing';
import {
  createPlanReuseStore,
  issueBodyHash,
  savePrFrozenSpec,
  savePrRunState,
  type PrRunState,
} from '@on-par/factory-core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { restorePrRunStateForRun, shipRunStateRecorder } from './ship-pr-state.js';

const SELF = 7;
const REPO = 'o/r';
const BRANCH = 'ship-it/42-thing';
const key = workKeyFromIssue(42);
const SHA = 'abc1234def';

type Stored = { id: number; user: { id: number }; body: string };

function fakeOctokit(): { octokit: Octokit; comments: Stored[] } {
  const comments: Stored[] = [];
  let next = 100;
  const pulls = [{ number: 9, head: { ref: BRANCH, sha: SHA, repo: { full_name: REPO } } }];
  const rest = {
    users: { getAuthenticated: async () => ({ data: { id: SELF } }) },
    pulls: { list: async () => ({ data: pulls }), get: async () => ({ data: { head: { sha: SHA } } }) },
    issues: {
      listComments: async ({ page }: { page: number }) => ({ data: page === 1 ? comments : [] }),
      createComment: async ({ body }: { body: string }) => {
        const c = { id: next++, user: { id: SELF }, body };
        comments.push(c);
        return { data: c };
      },
      updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => {
        const c = comments.find((x) => x.id === comment_id);
        if (c) c.body = body;
        return { data: c };
      },
    },
  };
  return { octokit: Object.assign({} as Octokit, { rest }), comments };
}

function prState(): PrRunState {
  return {
    version: 1,
    key,
    prNumber: 9,
    status: 'awaiting-review',
    spec: { sha256: 'a'.repeat(64), summary: 'goal' },
    checkRework: { used: 1, cap: 3 },
    reviewRework: { used: 0, cap: 3 },
    handledReviewIds: [],
    handledCommentIds: [],
    rounds: [],
    updatedAt: '2026-11-04T01:00:00.000Z',
  };
}

describe('ship PR frozen plan', () => {
  let dir: string;
  let events: { kind: EventKind; msg: string }[];
  const log = (kind: EventKind, msg: string): void => {
    events.push({ kind, msg });
  };
  const base = (octokit: Octokit) => ({
    octokit,
    repo: REPO,
    branch: BRANCH,
    issueNum: 42,
    reviewReworkFile: join(dir, 'state', 'review-rework.json'),
    runsDir: join(dir, 'state', 'runs'),
    maxReviewReworkRuns: 3,
    log,
  });
  const temp = createTempDirs();
  beforeEach(() => {
    dir = temp.makeSync('pr-frozen-');
    events = [];
  });
  afterEach(() => temp.cleanup());

  describe('frozen plan on a fresh clone (#4025)', () => {
    const BRIEF = 'Fix the thing\n\nbody';
    const DESIGN = {
      restatedProblem: 'problem',
      approach: { chosen: 'chosen', rejected: [] },
      interfacesTouched: [],
      targetTypes: [],
      signatures: [],
      callGraph: [],
      behaviorContract: [],
      verificationPlan: [],
      riskBlastRadius: 'low',
      openQuestions: [],
    };
    const SPEC = `---\nroute: claude\ndesign: ${JSON.stringify(DESIGN)}\n---\n# Spec\n\n## Goal\n\nDo the thing.\n`;
    const specIn = (clone: string): string => join(clone, 'state', 'plans', 'issue-42.md');
    const shipOpts = (octokit: Octokit, clone: string, frozenSpec?: { specPath: string; brief: string }) => ({
      octokit,
      repo: REPO,
      branch: BRANCH,
      issueNum: 42,
      factoryConfig: { queue: { ...defaultFactoryConfig.queue, max_review_rework_runs: 3 } },
      paths: { reviewRework: join(clone, 'state', 'review-rework.json'), runs: join(clone, 'state', 'runs') },
      log,
      ...(frozenSpec ? { frozenSpec } : {}),
    });
    const baseUpdate = (clone: string) => ({
      lane: 'bugfix',
      worktree: clone,
      specPath: specIn(clone),
      startedAt: '2026-11-04T00:00:00.000Z',
    });
    const listAll = (root: string): string[] =>
      (
        readdirSync(root, { recursive: true, withFileTypes: true }) as {
          name: string;
          parentPath: string;
          isFile(): boolean;
        }[]
      )
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name));

    /** Run 1 in clone A: spec written, PR open, recorder pushes an update. Returns the fake PR and the spec text. */
    async function runOneAndKill(brief: string | undefined, status: 'shipping' | 'parked' = 'shipping') {
      const a = join(dir, 'A');
      mkdirSync(join(a, 'state', 'plans'), { recursive: true });
      writeFileSync(specIn(a), SPEC);
      const fake = fakeOctokit();
      const record = (
        await shipRunStateRecorder(
          false,
          shipOpts(fake.octokit, a, brief === undefined ? undefined : { specPath: specIn(a), brief }),
        )
      )(baseUpdate(a));
      await record({ status, prNumber: 9, attempts: 1 });
      return fake;
    }
    const freshClone = (): string => {
      const b = join(dir, 'B');
      mkdirSync(b, { recursive: true });
      return b;
    };

    it('an in-place run killed after its PR opened resumes on a fresh clone with the frozen plan and no PLAN call', async () => {
      const { octokit, comments } = await runOneAndKill(BRIEF);
      expect(comments.some((c) => c.body.includes('factory:run-state v1 key:42'))).toBe(true);
      expect(comments.some((c) => c.body.includes('factory:frozen-spec v1 key:42'))).toBe(true);
      events = [];

      const b = freshClone();
      await shipRunStateRecorder(false, shipOpts(octokit, b, { specPath: specIn(b), brief: BRIEF }));

      expect(readFileSync(specIn(b), 'utf8')).toBe(SPEC);
      const plan: string[] = [];
      const planLog = (kind: EventKind): void => void plan.push(kind);
      const reused = await loadReusablePlan(
        createPlanReuseStore(specIn(b)),
        { issue: key, specPath: specIn(b), work: { brief: BRIEF } },
        log,
        planLog,
      );
      expect(reused).toMatchObject({ ok: true, route: 'claude', model: 'plan-reused' });
      expect(plan).toContain('plan_reused');
      expect(listAll(b).every((f) => f.startsWith(join(b, 'state')))).toBe(true);
    });

    it('re-plans on a fresh clone when the issue body changed since the saved plan', async () => {
      const { octokit } = await runOneAndKill(BRIEF);
      const b = freshClone();
      await shipRunStateRecorder(false, shipOpts(octokit, b, { specPath: specIn(b), brief: 'a different issue body' }));
      expect(existsSync(specIn(b))).toBe(false);
      const reused = await loadReusablePlan(
        createPlanReuseStore(specIn(b)),
        { issue: key, specPath: specIn(b), work: { brief: 'a different issue body' } },
        log,
        log,
      );
      expect(reused).toBeNull();
      expect(events.some((e) => e.msg.includes('planned from an older issue body'))).toBe(true);
    });

    it('does not restore the frozen plan when the PR run state is parked', async () => {
      const { octokit } = await runOneAndKill(BRIEF, 'parked');
      const b = freshClone();
      await shipRunStateRecorder(false, shipOpts(octokit, b, { specPath: specIn(b), brief: BRIEF }));
      expect(existsSync(specIn(b))).toBe(false);
    });

    it('keeps a local frozen spec over the PR copy', async () => {
      const { octokit } = await runOneAndKill(BRIEF);
      const b = freshClone();
      mkdirSync(join(b, 'state', 'plans'), { recursive: true });
      writeFileSync(specIn(b), 'local spec');
      await shipRunStateRecorder(false, shipOpts(octokit, b, { specPath: specIn(b), brief: BRIEF }));
      expect(readFileSync(specIn(b), 'utf8')).toBe('local spec');
    });

    it('saves no frozen spec without frozenSpec (worktree mode) and when skipped', async () => {
      const worktree = await runOneAndKill(undefined);
      expect(worktree.comments.some((c) => c.body.includes('factory:frozen-spec'))).toBe(false);

      const a = join(dir, 'A2');
      mkdirSync(join(a, 'state', 'plans'), { recursive: true });
      writeFileSync(specIn(a), SPEC);
      const skipped = fakeOctokit();
      const record = (
        await shipRunStateRecorder(true, shipOpts(skipped.octokit, a, { specPath: specIn(a), brief: BRIEF }))
      )(baseUpdate(a));
      await record({ status: 'shipping', prNumber: 9 });
      expect(skipped.comments).toHaveLength(0);
    });

    it('removes the restored spec and logs when it has no build route', async () => {
      const fake = fakeOctokit();
      await savePrRunState({ octokit: fake.octokit, repo: REPO, prNumber: 9, state: prState() });
      await savePrFrozenSpec({
        octokit: fake.octokit,
        repo: REPO,
        prNumber: 9,
        state: { version: 1, key, bodyHash: issueBodyHash(BRIEF), spec: '# no route' },
      });
      const b = freshClone();
      await shipRunStateRecorder(false, shipOpts(fake.octokit, b, { specPath: specIn(b), brief: BRIEF }));
      expect(existsSync(specIn(b))).toBe(false);
      expect(events.some((e) => e.kind === 'pr_state_failed')).toBe(true);
    });

    it('logs ignored frozen-plan comments, an oversized spec and failures without throwing', async () => {
      const fake = await runOneAndKill(BRIEF);
      const forged = fake.comments.find((c) => c.body.includes('factory:frozen-spec v1'));
      if (forged) fake.comments.push({ id: 1, user: { id: 99 }, body: forged.body });
      const b = freshClone();
      await shipRunStateRecorder(false, shipOpts(fake.octokit, b, { specPath: specIn(b), brief: BRIEF }));
      expect(events.some((e) => e.kind === 'pr_state_ignored' && e.msg.includes('untrusted-author'))).toBe(true);

      const big = join(dir, 'C');
      mkdirSync(join(big, 'state', 'plans'), { recursive: true });
      writeFileSync(specIn(big), `${SPEC}${'x'.repeat(70_000)}`);
      const record = (
        await shipRunStateRecorder(false, shipOpts(fake.octokit, big, { specPath: specIn(big), brief: BRIEF }))
      )(baseUpdate(big));
      await record({ status: 'shipping', prNumber: 9 });
      expect(events.some((e) => e.msg.includes('too large for one PR comment'))).toBe(true);

      const failing = fakeOctokit();
      await savePrRunState({ octokit: failing.octokit, repo: REPO, prNumber: 9, state: prState() });
      const listOnce = failing.octokit.rest.issues.listComments;
      let calls = 0;
      Object.assign(failing.octokit.rest.issues, {
        listComments: async (args: Parameters<typeof listOnce>[0]) => {
          if (++calls > 1) throw new Error('list down');
          return listOnce(args);
        },
      });
      const c = join(dir, 'D');
      mkdirSync(c, { recursive: true });
      const restored = await restorePrRunStateForRun({
        ...base(failing.octokit),
        reviewReworkFile: join(c, 'rr.json'),
        runsDir: join(c, 'runs'),
        frozenSpec: { specPath: specIn(c), brief: BRIEF },
      });
      expect(restored?.prNumber).toBe(9);
      expect(events.some((e) => e.kind === 'pr_state_failed' && e.msg.includes('list down'))).toBe(true);
    });

    it('logs and carries on when the frozen spec cannot be saved to the PR or written locally', async () => {
      const fake = await runOneAndKill(BRIEF);
      const b = freshClone();
      mkdirSync(join(b, 'state', 'plans'), { recursive: true });
      chmodSync(join(b, 'state', 'plans'), 0o500);
      try {
        await shipRunStateRecorder(false, shipOpts(fake.octokit, b, { specPath: specIn(b), brief: BRIEF }));
      } finally {
        chmodSync(join(b, 'state', 'plans'), 0o700);
      }
      expect(events.some((e) => e.kind === 'pr_state_failed' && e.msg.includes('restore the frozen plan'))).toBe(true);

      const down = fakeOctokit();
      Object.assign(down.octokit.rest.issues, {
        createComment: async ({ body }: { body: string }) => {
          if (body.includes('factory:frozen-spec')) throw new Error('create down');
          const c = { id: 500, user: { id: SELF }, body };
          down.comments.push(c);
          return { data: c };
        },
      });
      const a = join(dir, 'E');
      mkdirSync(join(a, 'state', 'plans'), { recursive: true });
      writeFileSync(specIn(a), SPEC);
      const record = (
        await shipRunStateRecorder(false, shipOpts(down.octokit, a, { specPath: specIn(a), brief: BRIEF }))
      )(baseUpdate(a));
      await record({ status: 'shipping', prNumber: 9 });
      expect(events.some((e) => e.msg.includes('could not save the frozen spec to the PR: create down'))).toBe(true);
    });
  });
});
