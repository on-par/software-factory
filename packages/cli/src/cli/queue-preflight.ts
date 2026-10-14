import type {
  CiOutcome,
  QueueIssue,
  QueuePreflightDecision,
  SlicePlan,
  SlicePlanCommentLookup,
} from '@on-par/factory-core/internal';
import { withSliceState } from '@on-par/factory-core/internal';
import type { FactoryEvent } from '@on-par/factory-core';
import { errorDetail } from './index.js';
import type { getPullRequestLandState } from './land-pr.js';
import { decideReworkAdoption } from './rework-adopt.js';

export interface OpenPullRequestEvidence {
  number: number;
  branch: string;
  headSha: string;
  headRepoFullName: string | null;
}

/** A slice PR's state as the queue preflight sees it (ADR-0147). */
export type SlicePullState = 'open' | 'merged' | 'closed';

export interface QueuePreflightOps {
  expectedHeadRepoFullName: string;
  /** Every open PR whose body says "Closes #N"; more than one parks as ambiguous (#2253). */
  findOpenPRs(issue: number): Promise<OpenPullRequestEvidence[]>;
  /** The issue's most recent park event in the local events log, if any (#2253). */
  lastPark(issue: number): FactoryEvent | undefined;
  /** Factory branch prefix used to recognise an adoptable stranded PR branch. */
  branchPrefix?: string;
  getLandState(prNumber: number): ReturnType<typeof getPullRequestLandState>;
  watch(ref: string): Promise<CiOutcome>;
  /** The factory-written slice plan comment on the issue (ADR-0147). */
  findSlicePlan(issue: number): Promise<SlicePlanCommentLookup>;
  /** State of a slice PR found by the number recorded in the slice plan. */
  getPullState(prNumber: number): Promise<SlicePullState>;
  /** Rewrite the factory's slice plan comment in place. */
  saveSlicePlan(issue: number, plan: SlicePlan): Promise<void>;
  /** ADR-0161: sizeGate.mode is `stack` and the merge policy is auto, so preflight may adopt the lowest open stack layer. */
  autoMergeStack: boolean;
  /** Current head/base refs of a slice PR; the head SHA is the rebased one after GitHub retargets a layer. */
  getPullRefs(prNumber: number): Promise<{ headRef: string; baseRef: string; headSha: string }>;
}

/** ADR-0147/ADR-0161: walk every pr-open slice PR bottom-up. Merged layers are recorded, a closed layer parks
 *  (naming the layers above it), and the lowest open layer defers, or is adopted when stack auto-merge is on and
 *  its base is main with green CI on the rebased head. Returns undefined to fall through to the Closes-PR
 *  preflight only when no slice PR is still open. */
async function preflightSlice(issue: number, deps: QueuePreflightOps): Promise<QueuePreflightDecision | undefined> {
  let lookup: SlicePlanCommentLookup;
  try {
    lookup = await deps.findSlicePlan(issue);
  } catch (err) {
    return { kind: 'park', reason: `slice plan lookup failed: ${errorDetail(err)}` };
  }
  if (lookup.status === 'invalid') {
    return {
      kind: 'park',
      reason: `slice plan comment ${lookup.commentId} on #${issue} is unreadable (${lookup.error})`,
    };
  }
  if (lookup.status === 'not-found') return undefined;
  const { plan } = lookup;
  const n = plan.slices.length;
  const open = plan.slices.filter((s) => s.state === 'pr-open');
  if (open.length === 0) return undefined;
  let next = plan;
  let lastMerged: { label: string; pr: number } | undefined;
  const save = async (): Promise<QueuePreflightDecision | undefined> => {
    if (lastMerged === undefined) return undefined;
    try {
      await deps.saveSlicePlan(issue, next);
    } catch (err) {
      return {
        kind: 'park',
        reason: `${lastMerged.label} PR #${lastMerged.pr} merged but updating the slice plan failed: ${errorDetail(err)}`,
      };
    }
    return undefined;
  };
  for (const [at, slice] of open.entries()) {
    const label = `slice ${slice.index}/${n}`;
    if (slice.prNumber === undefined) {
      return { kind: 'park', reason: `${label} of #${issue} is pr-open but the slice plan records no PR number` };
    }
    const pr = slice.prNumber;
    let state: SlicePullState;
    try {
      state = await deps.getPullState(pr);
    } catch (err) {
      return { kind: 'park', reason: `${label} PR #${pr} state lookup failed: ${errorDetail(err)}` };
    }
    if (state === 'merged') {
      next = withSliceState(next, slice.index, 'merged', pr);
      lastMerged = { label, pr };
      continue;
    }
    if (state === 'closed') {
      const above = open.slice(at + 1);
      const suffix =
        above.length > 0
          ? `; layers above it: ${above.map((a) => `slice ${a.index}/${n} (#${a.prNumber})`).join(', ')}`
          : '';
      return { kind: 'park', reason: `${label} PR #${pr} was closed without merging${suffix}` };
    }
    const saved = await save();
    if (saved) return saved;
    if (!deps.autoMergeStack) return { kind: 'defer' };
    let refs: Awaited<ReturnType<QueuePreflightOps['getPullRefs']>>;
    try {
      refs = await deps.getPullRefs(pr);
    } catch (err) {
      return { kind: 'park', reason: `${label} PR #${pr} ref lookup failed: ${errorDetail(err)}` };
    }
    // GitHub has not retargeted the layer to main yet: the lower layer is still unmerged.
    if (refs.baseRef !== 'main') return { kind: 'defer' };
    let outcome: CiOutcome;
    try {
      outcome = await deps.watch(refs.headSha);
    } catch (err) {
      return { kind: 'park', reason: `CI watch for ${label} PR #${pr} failed: ${errorDetail(err)}` };
    }
    if (outcome === 'failure') return { kind: 'park', reason: `CI for ${label} PR #${pr} ended failure` };
    if (outcome !== 'success') return { kind: 'defer' };
    return { kind: 'adopt', branch: refs.headRef, stackLayer: { index: slice.index, count: n, prNumber: pr } };
  }
  return (await save()) ?? undefined;
}

/** Resolve queued work from GitHub evidence without consuming model or worktree resources. */
export async function preflightQueuedIssue(
  issue: QueueIssue,
  deps: QueuePreflightOps,
): Promise<QueuePreflightDecision> {
  if (issue.labels.includes('factory:in-progress')) return { kind: 'defer' };

  const slice = await preflightSlice(issue.number, deps);
  if (slice) return slice;

  let prs: OpenPullRequestEvidence[];
  try {
    prs = await deps.findOpenPRs(issue.number);
  } catch (err) {
    return { kind: 'park', reason: `PR lookup failed: ${errorDetail(err)}` };
  }
  if (prs.length === 0) return { kind: 'build' };
  if (prs.length > 1) {
    return {
      kind: 'park',
      reason: `ambiguous: ${prs.length} open PRs close #${issue.number} (${prs.map((p) => '#' + p.number).join(', ')}); not adopting any`,
    };
  }
  const pr = prs[0]!;
  if (pr.headRepoFullName !== deps.expectedHeadRepoFullName) {
    return { kind: 'park', reason: `PR #${pr.number} head is not in ${deps.expectedHeadRepoFullName}` };
  }

  let state: Awaited<ReturnType<typeof getPullRequestLandState>>;
  try {
    state = await deps.getLandState(pr.number);
  } catch (err) {
    return { kind: 'park', reason: `PR #${pr.number} merge-state lookup failed: ${errorDetail(err)}` };
  }
  if (state.isDraft === true) {
    const reworkPr = decideReworkAdoption({
      issue: issue.number,
      pr,
      expectedHeadRepoFullName: deps.expectedHeadRepoFullName,
      branchPrefix: deps.branchPrefix,
      lastPark: deps.lastPark(issue.number),
    });
    if (reworkPr) return { kind: 'build', reworkPr };
  }
  if (state.isDraft !== false) {
    return { kind: 'park', reason: `PR #${pr.number} is draft or its draft state is unavailable` };
  }
  if (!state.mergeStateStatus || state.mergeStateStatus === 'UNKNOWN') {
    return { kind: 'park', reason: `PR #${pr.number} merge state is unavailable` };
  }

  let outcome: CiOutcome;
  try {
    outcome = await deps.watch(pr.headSha);
  } catch (err) {
    return { kind: 'park', reason: `CI watch for PR #${pr.number} failed: ${errorDetail(err)}` };
  }
  if (outcome !== 'success') return { kind: 'park', reason: `CI for PR #${pr.number} ended ${outcome}` };
  return { kind: 'adopt', branch: pr.branch };
}
