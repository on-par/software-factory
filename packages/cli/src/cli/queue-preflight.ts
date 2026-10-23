import type { Octokit } from '@octokit/rest';
import type {
  CiOutcome,
  QueueIssue,
  QueuePreflightDecision,
  SlicePlan,
  SlicePlanCommentLookup,
  StackPullReviews,
} from '@on-par/factory-core/internal';
import {
  findDeclaredPrerequisites,
  findSlicePlanComment,
  readStackSliceGate,
  upsertSlicePlanComment,
  withSliceState,
} from '@on-par/factory-core/internal';
import { errorDetail } from './index.js';
import { findOpenPRForIssue } from './land.js';
import { getPullRequestLandState } from './land-pr.js';
import { findMergedClosingPr } from './queue-merged-closing-pr.js';

/** Backoff before each merge-state re-read (#3323): GitHub reports UNKNOWN while it recomputes mergeability. */
export const MERGE_STATE_REREAD_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000];

const defaultSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface OpenPullRequestEvidence {
  number: number;
  branch: string;
  headSha: string;
  headRepoFullName: string | null;
}

/** A slice PR's state as the queue preflight sees it (ADR-0147). */
export type SlicePullState = 'open' | 'merged' | 'closed';

/** Reports the in-flight issue holding a file this issue needs, if any. */
export type LaneFileHoldLookup = (issue: number) => Promise<{ holder: number; file: string } | undefined>;

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
  /** ADR-0161: sizeGate.mode is `stack`, so an approved top slice lets the queue build the next pending slice (#3366). Slice mode keeps waiting for the merge (ADR-0147). */
  stackMode: boolean;
  /** Head SHA, the factory's own user id, and the reviews of a slice PR (#3366). */
  getPullReviews(prNumber: number): Promise<StackPullReviews>;
  readIssueBody(issue: number): Promise<string>;
  getPrerequisiteState(issue: number): Promise<{ state: 'open' | 'closed'; mergedClosingPr: boolean }>;
  /** #3375: number of a PR that closes `issue` by reference, merged into the default branch and not reverted by a merged `Reverts owner/repo#N` PR; undefined when none. */
  getMergedClosingPr(issue: number): Promise<number | undefined>;
  onDeferred?: (issue: number, message: string) => void;
  /** #3576: the in-flight issue and file this issue was deferred behind, while that claim is still live; undefined when none. */
  laneFileHold?: LaneFileHoldLookup;
  /** Backoff before each merge-state re-read (#3323). Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Current head/base refs of a slice PR; the head SHA is the rebased one after GitHub retargets a layer. */
  getPullRefs(prNumber: number): Promise<{ headRef: string; baseRef: string; headSha: string }>;
  /** True when `branch` still holds commit `sha` (compare status ahead or identical); false for a missing branch (#3368). */
  branchContains(sha: string, branch: string): Promise<boolean>;
}

export function makeQueuePreflightOps(
  octokit: Octokit,
  owner: string,
  repo: string,
  opts: {
    watch: (ref: string) => Promise<CiOutcome>;
    autoMergeStack?: boolean;
    stackMode?: boolean;
    onDeferred?: (issue: number, message: string) => void;
    laneFileHold?: LaneFileHoldLookup;
    sleep?: (ms: number) => Promise<void>;
  },
): QueuePreflightOps {
  let selfId: Promise<number> | undefined;
  return {
    autoMergeStack: opts.autoMergeStack ?? false,
    stackMode: opts.stackMode ?? false,
    getPullReviews: async (prNumber) => {
      const { data: pull } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      selfId ??= octokit.rest.users.getAuthenticated().then(({ data }) => data.id);
      const id = await selfId;
      const reviews: StackPullReviews['reviews'] = [];
      for (let page = 1; ; page++) {
        const { data } = await octokit.rest.pulls.listReviews({
          owner,
          repo,
          pull_number: prNumber,
          per_page: 100,
          page,
        });
        for (const r of data) {
          reviews.push({ reviewerId: r.user?.id ?? null, state: r.state, commitId: r.commit_id ?? null });
        }
        if (data.length < 100) break;
      }
      return { headSha: pull.head.sha, selfId: id, reviews };
    },
    onDeferred: opts.onDeferred,
    laneFileHold: opts.laneFileHold,
    sleep: opts.sleep ?? defaultSleep,
    getPullRefs: async (prNumber) => {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      return { headRef: data.head.ref, baseRef: data.base.ref, headSha: data.head.sha };
    },
    branchContains: async (sha, branch) => {
      try {
        const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead: `${sha}...${branch}`,
        });
        return data.status === 'ahead' || data.status === 'identical';
      } catch (err) {
        if ((err as { status?: unknown }).status === 404) return false;
        throw err;
      }
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
    getMergedClosingPr: (issue) => findMergedClosingPr(octokit, owner, repo, issue),
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
 *  its base is main with green CI on the rebased head. In stack mode a lowest open layer that would defer instead
 *  builds the next pending slice once the top built slice PR is merged or approved (#3366). Returns undefined to fall through to the Closes-PR
 *  preflight only when no slice PR is still open. `hasPlan` is true when a slice plan was found (#3375). */
async function preflightSlice(
  issue: number,
  deps: QueuePreflightOps,
): Promise<{ decision?: QueuePreflightDecision; hasPlan: boolean }> {
  let lookup: SlicePlanCommentLookup;
  try {
    lookup = await deps.findSlicePlan(issue);
  } catch (err) {
    return { decision: { kind: 'park', reason: `slice plan lookup failed: ${errorDetail(err)}` }, hasPlan: false };
  }
  if (lookup.status === 'invalid') {
    return {
      decision: {
        kind: 'park',
        reason: `slice plan comment ${lookup.commentId} on #${issue} is unreadable (${lookup.error})`,
      },
      hasPlan: true,
    };
  }
  if (lookup.status === 'not-found') return { hasPlan: false };
  return { decision: await sliceDecision(issue, lookup.plan, deps), hasPlan: true };
}

async function sliceDecision(
  issue: number,
  plan: SlicePlan,
  deps: QueuePreflightOps,
): Promise<QueuePreflightDecision | undefined> {
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
  const waitOrBuild = async (): Promise<QueuePreflightDecision> => {
    if (!deps.stackMode) return { kind: 'defer' };
    let gate: Awaited<ReturnType<typeof readStackSliceGate>>;
    try {
      gate = await readStackSliceGate(next, {
        getPullState: deps.getPullState,
        getPullReviews: deps.getPullReviews,
      });
    } catch (err) {
      deps.onDeferred?.(issue, `stack approval lookup failed: ${errorDetail(err)}`);
      return { kind: 'defer' };
    }
    if (gate.status === 'none') return { kind: 'defer' };
    const above = next.slices.find((s) => s.index === gate.index + 1);
    if (above?.state !== 'pending') return { kind: 'defer' };
    if (gate.status === 'approved' || gate.status === 'merged') return { kind: 'build' };
    deps.onDeferred?.(
      issue,
      gate.status === 'changes-requested'
        ? `slice ${gate.index}/${n} PR #${gate.prNumber} has changes requested`
        : `waiting for review approval of slice ${gate.index}/${n} PR #${gate.prNumber}`,
    );
    return { kind: 'defer' };
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
    let refs: Awaited<ReturnType<QueuePreflightOps['getPullRefs']>> | undefined;
    // #3368: the layer below was squash-merged but this branch still carries its original commits: restack it.
    const below = deps.stackMode ? next.slices.find((s) => s.index === slice.index - 1) : undefined;
    if (below?.state === 'merged' && below.prNumber !== undefined) {
      try {
        const mergedRefs = await deps.getPullRefs(below.prNumber);
        refs = await deps.getPullRefs(pr);
        if (await deps.branchContains(mergedRefs.headSha, refs.headRef)) {
          return { kind: 'restack', mergedIndex: below.index, mergedPrNumber: below.prNumber };
        }
      } catch (err) {
        return { kind: 'park', reason: `${label} PR #${pr} restack check failed: ${errorDetail(err)}` };
      }
    }
    if (!deps.autoMergeStack) return waitOrBuild();
    if (refs === undefined) {
      try {
        refs = await deps.getPullRefs(pr);
      } catch (err) {
        return { kind: 'park', reason: `${label} PR #${pr} ref lookup failed: ${errorDetail(err)}` };
      }
    }
    // GitHub has not retargeted the layer to main yet: the lower layer is still unmerged.
    if (refs.baseRef !== 'main') return waitOrBuild();
    let outcome: CiOutcome;
    try {
      outcome = await deps.watch(refs.headSha);
    } catch (err) {
      return { kind: 'park', reason: `CI watch for ${label} PR #${pr} failed: ${errorDetail(err)}` };
    }
    if (outcome === 'failure') return { kind: 'park', reason: `CI for ${label} PR #${pr} ended failure` };
    if (outcome !== 'success') return waitOrBuild();
    return { kind: 'adopt', branch: refs.headRef, stackLayer: { index: slice.index, count: n, prNumber: pr } };
  }
  return (await save()) ?? undefined;
}

/** #3375: park when a merged PR already closes the issue; a lookup error builds as on main. */
async function alreadyLanded(issue: number, deps: QueuePreflightOps): Promise<QueuePreflightDecision> {
  try {
    const merged = await deps.getMergedClosingPr(issue);
    if (merged !== undefined) {
      return { kind: 'park', reason: `work already landed: merged PR #${merged} closes #${issue}` };
    }
  } catch {
    // a failed lookup builds, as on main
  }
  return { kind: 'build' };
}

/** Resolve queued work from GitHub evidence without consuming model or worktree resources. */
export async function preflightQueuedIssue(
  issue: QueueIssue,
  deps: QueuePreflightOps,
): Promise<QueuePreflightDecision> {
  if (issue.labels.includes('factory:in-progress')) return { kind: 'defer' };

  let hold: Awaited<ReturnType<LaneFileHoldLookup>>;
  try {
    hold = await deps.laneFileHold?.(issue.number);
  } catch (err) {
    deps.onDeferred?.(issue.number, `lane-file hold lookup failed: ${errorDetail(err)}`);
    hold = undefined; // a failed lookup builds; runIssue's lane guard re-checks after PLAN
  }
  if (hold) {
    deps.onDeferred?.(issue.number, `waiting for in-flight issue #${hold.holder} to release ${hold.file}`);
    return { kind: 'defer' };
  }

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
  if (slice.decision) return slice.decision;

  let pr: OpenPullRequestEvidence | undefined;
  try {
    pr = await deps.findOpenPR(issue.number);
  } catch (err) {
    return { kind: 'park', reason: `PR lookup failed: ${errorDetail(err)}` };
  }
  if (!pr) return slice.hasPlan ? { kind: 'build' } : alreadyLanded(issue.number, deps);
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
  const unknown = (s: typeof state) => !s.mergeStateStatus || s.mergeStateStatus === 'UNKNOWN';
  if (unknown(state)) {
    const sleep = deps.sleep ?? defaultSleep;
    for (const delay of MERGE_STATE_REREAD_DELAYS_MS) {
      await sleep(delay);
      try {
        state = await deps.getLandState(pr.number);
      } catch {
        continue; // a failed re-read counts as UNKNOWN for this attempt
      }
      if (!unknown(state)) break;
    }
    if (state.isDraft !== false) {
      return { kind: 'park', reason: `PR #${pr.number} is draft or its draft state is unavailable` };
    }
    // #3324: still UNKNOWN after the re-reads, so the head may be stale; land merges main in before its CI watch.
    if (unknown(state)) return { kind: 'adopt', branch: pr.branch, syncMain: true };
  }
  // #3324: no pull_request CI runs on a conflicting head, so skip the watch and let land merge main in first.
  if (state.mergeStateStatus === 'DIRTY') return { kind: 'adopt', branch: pr.branch, syncMain: true };

  let outcome: CiOutcome;
  try {
    outcome = await deps.watch(pr.headSha);
  } catch (err) {
    return { kind: 'park', reason: `CI watch for PR #${pr.number} failed: ${errorDetail(err)}` };
  }
  if (outcome !== 'success') return { kind: 'park', reason: `CI for PR #${pr.number} ended ${outcome}` };
  return { kind: 'adopt', branch: pr.branch };
}
