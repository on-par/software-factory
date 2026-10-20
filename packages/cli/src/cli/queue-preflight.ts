import type { Octokit } from '@octokit/rest';
import type {
  CiOutcome,
  QueueIssue,
  QueuePreflightDecision,
  SlicePlan,
  SlicePlanCommentLookup,
} from '@on-par/factory-core/internal';
import {
  findDeclaredPrerequisites,
  findSlicePlanComment,
  upsertSlicePlanComment,
  withSliceState,
} from '@on-par/factory-core/internal';
import { errorDetail } from './index.js';
import { findOpenPRForIssue } from './land.js';
import { getPullRequestLandState } from './land-pr.js';

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
  findOpenPR(issue: number): Promise<OpenPullRequestEvidence | undefined>;
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
  readIssueBody(issue: number): Promise<string>;
  getPrerequisiteState(issue: number): Promise<{ state: 'open' | 'closed'; mergedClosingPr: boolean }>;
  onDeferred?: (issue: number, message: string) => void;
  /** Current head/base refs of a slice PR; the head SHA is the rebased one after GitHub retargets a layer. */
  getPullRefs(prNumber: number): Promise<{ headRef: string; baseRef: string; headSha: string }>;
}

export function makeQueuePreflightOps(
  octokit: Octokit,
  owner: string,
  repo: string,
  opts: {
    watch: (ref: string) => Promise<CiOutcome>;
    autoMergeStack?: boolean;
    onDeferred?: (issue: number, message: string) => void;
  },
): QueuePreflightOps {
  return {
    autoMergeStack: opts.autoMergeStack ?? false,
    onDeferred: opts.onDeferred,
    getPullRefs: async (prNumber) => {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      return { headRef: data.head.ref, baseRef: data.base.ref, headSha: data.head.sha };
    },
    expectedHeadRepoFullName: `${owner}/${repo}`,
    findOpenPR: (issue) => findOpenPRForIssue(octokit, owner, repo, issue),
    getLandState: (prNumber) => getPullRequestLandState(octokit, owner, repo, prNumber),
    watch: opts.watch,
    findSlicePlan: (issue) => findSlicePlanComment({ octokit, repo: `${owner}/${repo}`, issue }),
    getPullState: async (prNumber) => {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      if (data.merged || data.merged_at) return 'merged';
      return data.state === 'open' ? 'open' : 'closed';
    },
    saveSlicePlan: async (issue, plan) => {
      await upsertSlicePlanComment({ octokit, repo: `${owner}/${repo}`, issue, plan });
    },
    readIssueBody: async (issue) => {
      const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: issue });
      if (
        !data ||
        typeof data !== 'object' ||
        data.number !== issue ||
        !(data.body === null || typeof data.body === 'string')
      ) {
        throw new Error(`issue #${issue} body response was malformed`);
      }
      return data.body ?? '';
    },
    getPrerequisiteState: async (issue) => {
      let after: string | null = null;
      let mergedClosingPr = false;
      let state: 'open' | 'closed' | undefined;
      do {
        const response: unknown = await octokit.graphql(
          `query QueuePrerequisite($owner: String!, $repo: String!, $number: Int!, $after: String) {
            repository(owner: $owner, name: $repo) {
              issue(number: $number) {
                state
                closedByPullRequestsReferences(first: 100, includeClosedPrs: true, after: $after) {
                  nodes { merged }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }`,
          { owner, repo, number: issue, after },
        );
        if (!isRecord(response) || !isRecord(response.repository) || !isRecord(response.repository.issue)) {
          throw new Error(`prerequisite #${issue} response was incomplete`);
        }
        const item = response.repository.issue;
        if (item.state !== 'OPEN' && item.state !== 'CLOSED')
          throw new Error(`prerequisite #${issue} state was malformed`);
        const nextState = item.state === 'OPEN' ? 'open' : 'closed';
        if (state !== undefined && state !== nextState)
          throw new Error(`prerequisite #${issue} state changed during pagination`);
        state = nextState;
        if (nextState === 'open') return { state: 'open', mergedClosingPr: false };
        if (!isRecord(item.closedByPullRequestsReferences))
          throw new Error(`prerequisite #${issue} closing PR evidence was incomplete`);
        const connection = item.closedByPullRequestsReferences;
        if (
          !Array.isArray(connection.nodes) ||
          !isRecord(connection.pageInfo) ||
          typeof connection.pageInfo.hasNextPage !== 'boolean'
        ) {
          throw new Error(`prerequisite #${issue} closing PR evidence was malformed`);
        }
        for (const node of connection.nodes) {
          if (!isRecord(node) || typeof node.merged !== 'boolean')
            throw new Error(`prerequisite #${issue} closing PR node was malformed`);
          if (node.merged) mergedClosingPr = true;
        }
        const hasNextPage = connection.pageInfo.hasNextPage;
        const cursor = connection.pageInfo.endCursor;
        if (hasNextPage && (typeof cursor !== 'string' || cursor.length === 0 || cursor === after)) {
          throw new Error(`prerequisite #${issue} pagination cursor was malformed`);
        }
        after = hasNextPage ? (cursor as string) : null;
      } while (after !== null && !mergedClosingPr);
      if (state === undefined) throw new Error(`prerequisite #${issue} state was unavailable`);
      return { state, mergedClosingPr };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

  let body: string;
  try {
    body = await deps.readIssueBody(issue.number);
  } catch (err) {
    deps.onDeferred?.(issue.number, `issue body lookup failed: ${errorDetail(err)}`);
    return { kind: 'defer' };
  }
  const prerequisites = findDeclaredPrerequisites(body);
  const open: number[] = [];
  const closedUnmerged: number[] = [];
  const errors: string[] = [];
  for (const prerequisite of prerequisites) {
    try {
      const evidence = await deps.getPrerequisiteState(prerequisite);
      if (evidence.state === 'open') open.push(prerequisite);
      else if (evidence.state === 'closed' && !evidence.mergedClosingPr) closedUnmerged.push(prerequisite);
      else if (evidence.state !== 'closed') errors.push(`#${prerequisite}: unexpected state`);
    } catch (err) {
      errors.push(`#${prerequisite}: ${errorDetail(err)}`);
    }
  }
  if (errors.length > 0) {
    const unresolved = [...open, ...closedUnmerged].map((number) => `#${number}`);
    const message = [
      `prerequisite evidence lookup failed: ${errors.join('; ')}`,
      unresolved.length ? `unresolved: ${unresolved.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    deps.onDeferred?.(issue.number, message);
    return { kind: 'defer' };
  }
  if (closedUnmerged.length > 0) return { kind: 'park', reason: `prerequisite #${closedUnmerged[0]} closed unmerged` };
  if (open.length > 0) {
    deps.onDeferred?.(issue.number, `waiting for prerequisites: ${open.map((number) => `#${number}`).join(', ')}`);
    return { kind: 'defer' };
  }

  const slice = await preflightSlice(issue.number, deps);
  if (slice) return slice;

  let pr: OpenPullRequestEvidence | undefined;
  try {
    pr = await deps.findOpenPR(issue.number);
  } catch (err) {
    return { kind: 'park', reason: `PR lookup failed: ${errorDetail(err)}` };
  }
  if (!pr) return { kind: 'build' };
  if (pr.headRepoFullName !== deps.expectedHeadRepoFullName) {
    return { kind: 'park', reason: `PR #${pr.number} head is not in ${deps.expectedHeadRepoFullName}` };
  }

  let state: Awaited<ReturnType<typeof getPullRequestLandState>>;
  try {
    state = await deps.getLandState(pr.number);
  } catch (err) {
    return { kind: 'park', reason: `PR #${pr.number} merge-state lookup failed: ${errorDetail(err)}` };
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
