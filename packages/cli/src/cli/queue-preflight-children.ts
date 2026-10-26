import type { Octokit } from '@octokit/rest';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * #3703: true when `issue` has sub-issues and every one is closed with a merged closing PR.
 * A further page of sub-issues or zero children fails closed (false); malformed evidence throws.
 */
export async function childrenMerged(octokit: Octokit, owner: string, repo: string, issue: number): Promise<boolean> {
  const response: unknown = await octokit.graphql(
    `query QueuePrerequisiteChildren($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          subIssues(first: 100) {
            nodes {
              number
              state
              closedByPullRequestsReferences(first: 100, includeClosedPrs: true) { nodes { merged } }
            }
            pageInfo { hasNextPage }
          }
        }
      }
    }`,
    { owner, repo, number: issue },
  );
  const malformed = (): Error => new Error(`prerequisite #${issue} sub-issue evidence was malformed`);
  if (!isRecord(response) || !isRecord(response.repository) || !isRecord(response.repository.issue)) throw malformed();
  const subIssues = response.repository.issue.subIssues;
  if (!isRecord(subIssues) || !Array.isArray(subIssues.nodes)) throw malformed();
  if (!isRecord(subIssues.pageInfo) || typeof subIssues.pageInfo.hasNextPage !== 'boolean') throw malformed();
  let allMerged = true;
  for (const child of subIssues.nodes) {
    if (!isRecord(child) || (child.state !== 'OPEN' && child.state !== 'CLOSED')) throw malformed();
    const refs = child.closedByPullRequestsReferences;
    if (!isRecord(refs) || !Array.isArray(refs.nodes)) throw malformed();
    let merged = false;
    for (const node of refs.nodes) {
      if (!isRecord(node) || typeof node.merged !== 'boolean') throw malformed();
      if (node.merged) merged = true;
    }
    if (child.state !== 'CLOSED' || !merged) allMerged = false;
  }
  return allMerged && !subIssues.pageInfo.hasNextPage && subIssues.nodes.length > 0;
}
