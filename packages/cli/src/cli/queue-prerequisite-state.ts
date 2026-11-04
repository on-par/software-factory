// packages/cli/src/cli/queue-prerequisite-state.ts — a declared prerequisite issue's state and merge evidence for queue preflight.

import type { Octokit } from '@octokit/rest';

import { childrenMerged } from './queue-preflight-children.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `mergedViaChildren` (#3703): closed COMPLETED and every sub-issue is closed with a merged closing PR. */
export async function readPrerequisiteState(
  octokit: Octokit,
  owner: string,
  repo: string,
  issue: number,
): Promise<{ state: 'open' | 'closed'; mergedClosingPr: boolean; mergedViaChildren?: boolean }> {
  let after: string | null = null;
  let mergedClosingPr = false;
  let state: 'open' | 'closed' | undefined;
  let stateReason: string | undefined;
  do {
    const response: unknown = await octokit.graphql(
      `query QueuePrerequisite($owner: String!, $repo: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $repo) {
            issue(number: $number) {
              state
              stateReason
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
    if (item.state !== 'OPEN' && item.state !== 'CLOSED') throw new Error(`prerequisite #${issue} state was malformed`);
    const nextState = item.state === 'OPEN' ? 'open' : 'closed';
    if (state !== undefined && state !== nextState)
      throw new Error(`prerequisite #${issue} state changed during pagination`);
    state = nextState;
    stateReason ??= typeof item.stateReason === 'string' ? item.stateReason : undefined;
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
  if (state === 'closed' && !mergedClosingPr && stateReason === 'COMPLETED') {
    return { state, mergedClosingPr, mergedViaChildren: await childrenMerged(octokit, owner, repo, issue) };
  }
  return { state, mergedClosingPr };
}
