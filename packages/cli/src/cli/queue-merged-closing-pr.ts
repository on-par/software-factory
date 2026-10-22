import type { Octokit } from '@octokit/rest';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** #3375: true when a merged PR in the repo carries GitHub's `Reverts <owner>/<repo>#<pr>` line. */
async function hasMergedRevert(octokit: Octokit, owner: string, repo: string, pr: number): Promise<boolean> {
  const response: unknown = await octokit.graphql(
    `query QueueRevertSearch($q: String!) {
      search(query: $q, type: ISSUE, first: 50) {
        nodes { ... on PullRequest { number merged body } }
      }
    }`,
    { q: `repo:${owner}/${repo} is:pr is:merged in:body "Reverts ${owner}/${repo}#${pr}"` },
  );
  if (!isRecord(response) || !isRecord(response.search) || !Array.isArray(response.search.nodes)) {
    throw new Error(`revert search for PR #${pr} was malformed`);
  }
  // Search is fuzzy, so each hit is re-confirmed: merged, and an exact line that stops `#9001` matching `#900`.
  const line = new RegExp(`^\\s*Reverts ${escapeRegExp(`${owner}/${repo}`)}#${pr}(?!\\d)`, 'im');
  return response.search.nodes.some(
    (node) => isRecord(node) && node.merged === true && typeof node.body === 'string' && line.test(node.body),
  );
}

/** #3375: the first PR that closes `issue` by reference, merged into the default branch and not reverted by a
 *  merged PR; undefined when none. Throws on malformed GitHub evidence. */
export async function findMergedClosingPr(
  octokit: Octokit,
  owner: string,
  repo: string,
  issue: number,
): Promise<number | undefined> {
  let after: string | null = null;
  do {
    const response: unknown = await octokit.graphql(
      `query QueueMergedClosingPr($owner: String!, $repo: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $repo) {
          defaultBranchRef { name }
          issue(number: $number) {
            closedByPullRequestsReferences(first: 100, includeClosedPrs: true, after: $after) {
              nodes { number merged baseRefName }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      { owner, repo, number: issue, after },
    );
    if (!isRecord(response) || !isRecord(response.repository) || !isRecord(response.repository.issue)) {
      throw new Error(`closing PR response for #${issue} was incomplete`);
    }
    const ref = response.repository.defaultBranchRef;
    if (!isRecord(ref) || typeof ref.name !== 'string' || ref.name.length === 0) {
      throw new Error(`default branch for #${issue} closing PR lookup was unavailable`);
    }
    const connection = response.repository.issue.closedByPullRequestsReferences;
    if (
      !isRecord(connection) ||
      !Array.isArray(connection.nodes) ||
      !isRecord(connection.pageInfo) ||
      typeof connection.pageInfo.hasNextPage !== 'boolean'
    ) {
      throw new Error(`closing PR evidence for #${issue} was malformed`);
    }
    for (const node of connection.nodes) {
      if (
        !isRecord(node) ||
        typeof node.number !== 'number' ||
        typeof node.merged !== 'boolean' ||
        typeof node.baseRefName !== 'string'
      ) {
        throw new Error(`closing PR node for #${issue} was malformed`);
      }
      if (node.merged && node.baseRefName === ref.name && !(await hasMergedRevert(octokit, owner, repo, node.number))) {
        return node.number;
      }
    }
    const { hasNextPage, endCursor } = connection.pageInfo;
    if (hasNextPage && (typeof endCursor !== 'string' || endCursor.length === 0 || endCursor === after)) {
      throw new Error(`closing PR pagination cursor for #${issue} was malformed`);
    }
    after = hasNextPage ? (endCursor as string) : null;
  } while (after !== null);
  return undefined;
}
