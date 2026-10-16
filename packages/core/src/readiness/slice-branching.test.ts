import { EpicSchema, StorySchema } from '@on-par/contracts';
import type { Story } from '@on-par/contracts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { designSmellsChecker, workerOutputChecker } from '../checkers/design-smells.js';
import type { RunOutcome } from '../run/outcome.js';
import type { RunRequest } from '../run/run-issue.js';
import { createStackSliceBranch } from '../run/stack-slice-branch.js';
import { runStackLoop } from '../run/stack-slice-entry.js';
import type { DecompositionOutput } from './decompose.js';
import {
  parentRefForSlice,
  parseSlicePlanComment,
  renderSlicePlanComment,
  slicePlanFromDecomposition,
  stackSliceBranch,
  withSliceBranchCreated,
  withSliceState,
} from './slice-plan.js';
import type { SlicePlan } from './slice-plan.js';

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

function freshPlan(count: number): SlicePlan {
  const decomposition: DecompositionOutput = {
    epic: EpicSchema.parse({
      kind: 'epic',
      title: 'Epic',
      why: 'because',
      doneWhen: ['done'],
      children: [],
      labels: [],
    }),
    stories: Array.from({ length: count }, (_, i) => story(`Story ${i + 1}`)),
  };
  const result = slicePlanFromDecomposition(2702, decomposition);
  if (!result.ok) throw new Error('expected ok');
  return result.plan;
}

describe('stackSliceBranch', () => {
  it('returns a deterministic factory/<issue>-slice-<index> name', () => {
    expect(stackSliceBranch(2702, 1)).toBe('factory/2702-slice-1');
    expect(stackSliceBranch(2702, 3)).toBe(stackSliceBranch(2702, 3));
    expect(stackSliceBranch(2702, 3)).toBe('factory/2702-slice-3');
  });
});

describe('parentRefForSlice', () => {
  it('returns origin/main for slice 1', () => {
    const plan = withSliceState(freshPlan(3), 1, 'pr-open', 11, stackSliceBranch(2702, 1));
    expect(parentRefForSlice(freshPlan(3), 1)).toBe('origin/main');
    expect(parentRefForSlice(plan, 1)).toBe('origin/main');
    expect(parentRefForSlice(plan, 1, 'origin/develop')).toBe('origin/develop');
  });

  it("returns the previous slice's recorded branch for slices 2 and 3", () => {
    let plan = withSliceState(freshPlan(3), 1, 'pr-open', 11, stackSliceBranch(2702, 1));
    plan = withSliceState(plan, 2, 'pr-open', 12, stackSliceBranch(2702, 2));
    expect(parentRefForSlice(plan, 2)).toBe('factory/2702-slice-1');
    expect(parentRefForSlice(plan, 3)).toBe('factory/2702-slice-2');
  });

  it('returns undefined when the previous slice has no recorded branch', () => {
    expect(parentRefForSlice(freshPlan(3), 2)).toBeUndefined();
  });

  it('returns undefined for an index outside the plan', () => {
    const plan = freshPlan(3);
    for (const index of [0, -1, 1.5, plan.slices.length + 1]) {
      expect(parentRefForSlice(plan, index)).toBeUndefined();
    }
  });
});

describe('withSliceBranchCreated', () => {
  it('records the slice branch in the plan comment on creation', () => {
    const plan = withSliceBranchCreated(freshPlan(3), 1);
    expect(plan.slices[0]?.branch).toBe('factory/2702-slice-1');
    const body = renderSlicePlanComment(plan);
    expect(body).toContain('branch `factory/2702-slice-1`');
    const parsed = parseSlicePlanComment(body);
    expect(parsed?.ok).toBe(true);
    if (parsed?.ok) expect(parsed.plan.slices[0]?.branch).toBe('factory/2702-slice-1');
  });

  it('keeps the slice pending when the plan is read back', () => {
    const parsed = parseSlicePlanComment(renderSlicePlanComment(withSliceBranchCreated(freshPlan(3), 2)));
    expect(parsed?.ok).toBe(true);
    if (!parsed?.ok) return;
    expect(parsed.plan.slices.map((s) => s.state)).toEqual(['pending', 'pending', 'pending']);
    expect(parsed.plan.slices[1]?.prNumber).toBeUndefined();
    expect(parsed.plan.slices[1]?.headSha).toBeUndefined();
  });

  it('lets parentRefForSlice resolve the next slice before SHIP', () => {
    const fresh = freshPlan(3);
    expect(parentRefForSlice(fresh, 2)).toBeUndefined();
    const plan = withSliceBranchCreated(fresh, 1);
    expect(parentRefForSlice(plan, 2)).toBe('factory/2702-slice-1');
  });

  it('records an explicit branch and leaves other slices and an existing state untouched', () => {
    const before = withSliceState(freshPlan(3), 1, 'pr-open', 11);
    const snapshot = structuredClone(before);
    const plan = withSliceBranchCreated(before, 1, 'factory/custom');
    expect(plan.slices[0]).toMatchObject({ state: 'pr-open', prNumber: 11, branch: 'factory/custom' });
    expect(plan.slices[1]).toEqual(before.slices[1]);
    expect(plan.slices[2]).toEqual(before.slices[2]);
    expect(before).toEqual(snapshot);
  });

  it('throws for an index outside the plan', () => {
    const plan = freshPlan(3);
    expect(() => withSliceBranchCreated(plan, 0)).toThrow(RangeError);
    expect(() => withSliceBranchCreated(plan, 4)).toThrow(RangeError);
  });
});

describe('CHECK diff base', () => {
  it('CHECK diff base: workerOutputChecker and designSmellsChecker diff against the slice parent ref', async () => {
    const plan = withSliceBranchCreated(freshPlan(3), 1);
    const ref = parentRefForSlice(plan, 2);
    expect(ref).toBe('factory/2702-slice-1');
    const seen: (string | undefined)[] = [];
    const collectDiff = (async (_w: string, _n: unknown, opts?: { baseRefOverride?: string }) => {
      seen.push(opts?.baseRefOverride);
      return { text: '', baseRef: ref, truncated: false };
    }) as any;
    const ctx = { worktree: '/w', specPath: '/w/spec.md', parentBaseRef: ref };
    await workerOutputChecker(ctx, { collectDiff });
    await designSmellsChecker(ctx, {} as any, undefined, { collectDiff, env: {} });
    expect(seen).toEqual([ref, ref]);
  });
});

describe('stack chain', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('each slice branch has the previous slice branch as merge-base', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stack-chain-'));
    dir = root;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const commit = (name: string) => {
      writeFileSync(join(root, name), name);
      git('add', '.');
      git('commit', '-m', name);
      return git('rev-parse', 'HEAD');
    };
    git('init', '-b', 'main');
    git('config', 'user.name', 'T');
    git('config', 'user.email', 't@example.com');
    git('config', 'commit.gpgsign', 'false');
    const mainSha = commit('base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');

    let plan = freshPlan(3);
    const heads: string[] = [];
    for (let k = 1; k <= 3; k++) {
      const parent = parentRefForSlice(plan, k);
      await createStackSliceBranch({ worktree: root, branch: stackSliceBranch(2702, k), startPoint: parent! });
      heads.push(commit(`slice-${k}`));
      plan = withSliceBranchCreated(plan, k);
    }

    expect(git('merge-base', 'factory/2702-slice-2', 'factory/2702-slice-1')).toBe(heads[0]);
    expect(git('merge-base', 'factory/2702-slice-3', 'factory/2702-slice-2')).toBe(heads[1]);
    expect(git('merge-base', 'factory/2702-slice-1', 'origin/main')).toBe(mainSha);
  });
});

describe('runStackLoop cap', () => {
  const fakeRunOnce = (count: number) =>
    vi.fn(
      async (req: RunRequest) =>
        ({
          state: 'ready',
          route: 'codex',
          branch: 'b',
          reworkRounds: 0,
          slice: { index: req.sliceIndex ?? 1, count },
        }) as RunOutcome,
    );

  it('stops at maxSlices for a plan above the cap', async () => {
    const runOnce = fakeRunOnce(3);
    const outcome = await runStackLoop({ sizeGateMode: 'stack', maxSlices: 2 } as RunRequest, runOnce);

    expect(runOnce.mock.calls.map((c) => c[0].sliceIndex)).toEqual([undefined, 2]);
    expect(outcome).toMatchObject({ slice: { index: 2, count: 3 } });
  });

  it('builds every slice when the default cap does not bite', async () => {
    const runOnce = fakeRunOnce(3);
    await runStackLoop({ sizeGateMode: 'stack' } as RunRequest, runOnce);

    expect(runOnce.mock.calls.map((c) => c[0].sliceIndex)).toEqual([undefined, 2, 3]);
  });
});
