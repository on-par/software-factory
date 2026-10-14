// src/blockers/poller.ts — auto-unpark parents parked `blocked` once their blockers resolve (#2318, ADR-0018, ADR-0044).
//
// Deterministic: reads the trusted park comment plus GitHub `blocked_by`, never an LLM. Unknown or malformed
// input fails closed (stays parked or goes `held`), never unparks.

import type { Octokit } from '@octokit/rest';

import { PARKED_LABEL, type QueueGitHubClient } from '../queue/github-queue.js';
import { runUnpark, UnparkError } from '../queue/unpark.js';
import { findOwnParkComment, type ParkCommentPatch, patchParkComment, readParkState } from '../run/park-comment.js';
import type { ParkStateComment } from '../run/park-comment.js';
import { type BlockedByItem, listBlockedBy } from './dependencies.js';
import { BLOCKER_MARKER_RE } from './file-blocker.js';

export const MAX_AUTO_UNPARKS = 2;

export interface BlockerEvidence {
  factoryFiled: boolean;
  mergedClosingPr: boolean;
}

export interface BlockedParkStore {
  /** The authenticated identity's lowest-id park-state comment on `issue`, or undefined. */
  readParkComment(issue: number): Promise<ParkStateComment | undefined>;
  updateComment(commentId: number, body: string): Promise<void>;
  listBlockedBy(issue: number): Promise<BlockedByItem[]>;
  /** Only asked for same-repo blockers that are closed `completed`. */
  blockerEvidence(blocker: number): Promise<BlockerEvidence>;
}

export type BlockedParkOutcome = 'unparked' | 'held' | 'capped' | 'waiting' | 'skipped' | 'raced' | 'error';

export interface BlockedParkPollResult {
  issue: number;
  outcome: BlockedParkOutcome;
  detail?: string;
  lane?: string;
  order?: number;
}

export interface PollBlockedParksOptions {
  client: QueueGitHubClient;
  owner: string;
  repo: string;
  store: BlockedParkStore;
  /** Event sink; the CLI wires it to the events log. Defaults to a no-op. */
  logEvent?: (kind: 'issue_unparked' | 'warn', issue: number, message: string) => void;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function pollOne(opts: PollBlockedParksOptions, n: number): Promise<BlockedParkPollResult> {
  const { client, owner, repo, store, logEvent = () => {} } = opts;
  const comment = await store.readParkComment(n);
  const state = comment && readParkState([comment], n);
  if (!comment || !state) return { issue: n, outcome: 'skipped', detail: 'no park comment' };
  if (state.reason !== 'blocked') return { issue: n, outcome: 'skipped', detail: `reason ${state.reason}` };

  const blockers = await store.listBlockedBy(n);
  if (blockers.length === 0) return { issue: n, outcome: 'skipped', detail: 'no blockers' };

  let waiting = false;
  let abandoned: string | undefined;
  for (const b of blockers) {
    if (b.state === 'open') {
      waiting = true;
    } else if (b.stateReason === 'completed') {
      if (b.repository === `${owner}/${repo}`) {
        const ev = await store.blockerEvidence(b.number);
        if (ev.factoryFiled && !ev.mergedClosingPr) waiting = true;
      }
    } else {
      abandoned ??= `blocker #${b.number} closed ${b.stateReason ?? 'without a reason'}`;
    }
  }

  const hold = async (outcome: 'held' | 'capped', detail: string): Promise<BlockedParkPollResult> => {
    const patch: ParkCommentPatch = { reason: 'held', status: `held: ${detail}` };
    const body = patchParkComment(comment.body, n, patch);
    if (body !== null) await store.updateComment(comment.id, body);
    return { issue: n, outcome, detail };
  };

  if (abandoned !== undefined) return hold('held', abandoned);
  if (waiting) return { issue: n, outcome: 'waiting' };
  if (state.autoUnparks >= MAX_AUTO_UNPARKS) return hold('capped', `auto-unpark cap (${MAX_AUTO_UNPARKS}) reached`);

  let result;
  try {
    result = await runUnpark({ client, owner, repo, issue: n });
  } catch (err) {
    if (err instanceof UnparkError && err.code === 'not-parked') {
      return { issue: n, outcome: 'raced', detail: err.message };
    }
    throw err;
  }
  logEvent(
    'issue_unparked',
    n,
    `#${n} auto-unparked → ${result.lane} (order ${result.order}): blockers ${blockers.map((b) => `#${b.number}`).join(', ')} resolved`,
  );
  try {
    const body = patchParkComment(comment.body, n, { status: 'resumed', autoUnparks: state.autoUnparks + 1 });
    if (body !== null) await store.updateComment(comment.id, body);
  } catch (err) {
    logEvent('warn', n, `park comment not updated: ${message(err)}`);
  }
  return { issue: n, outcome: 'unparked', lane: result.lane, order: result.order };
}

/** One failing parent never stops the poll of the others. */
export async function pollBlockedParks(opts: PollBlockedParksOptions): Promise<BlockedParkPollResult[]> {
  const { client, owner, repo } = opts;
  const parked = await client.listOpenIssuesWithLabels({ owner, repo, labels: [PARKED_LABEL] });
  const results: BlockedParkPollResult[] = [];
  for (const { number } of parked) {
    try {
      results.push(await pollOne(opts, number));
    } catch (err) {
      results.push({ issue: number, outcome: 'error', detail: message(err) });
    }
  }
  return results;
}

const CLOSING_PRS_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){closedByPullRequestsReferences(first:25,includeClosedPrs:true){nodes{merged}}}}}`;

export function createOctokitBlockedParkStore(octokit: Octokit, repo: string): BlockedParkStore {
  const [owner, name] = repo.split('/') as [string, string];
  return {
    readParkComment: (issue) => findOwnParkComment({ octokit, repo, issue }),
    async updateComment(commentId, body) {
      await octokit.rest.issues.updateComment({ owner, repo: name, comment_id: commentId, body });
    },
    listBlockedBy: (issue) => listBlockedBy({ octokit, repo }, issue),
    async blockerEvidence(blocker) {
      const { data } = await octokit.rest.issues.get({ owner, repo: name, issue_number: blocker });
      const response: unknown = await octokit.graphql(CLOSING_PRS_QUERY, { owner, name, number: blocker });
      const nodes = (
        response as { repository?: { issue?: { closedByPullRequestsReferences?: { nodes?: unknown } } } } | null
      )?.repository?.issue?.closedByPullRequestsReferences?.nodes;
      return {
        factoryFiled: BLOCKER_MARKER_RE.test(data.body ?? ''),
        mergedClosingPr: Array.isArray(nodes) && nodes.some((x) => (x as { merged?: unknown } | null)?.merged === true),
      };
    },
  };
}
