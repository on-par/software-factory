// packages/cli/src/cli/land-behind.ts — stale-base detection for land (ADR-0170 slice a, #3654)

import type { Octokit } from '@octokit/rest';

/** Max merge-main syncs per land before it refuses as "base kept moving" (ADR-0170; matches MAX_REWORK_ROUNDS). */
export const MAX_LAND_SYNC_ROUNDS = 3;

/** True when `headSha` is missing commits from `baseRef` (compare `behind_by > 0`). GitHub reports BEHIND
 *  only under enforced strict protection, so mergeStateStatus alone cannot answer this (#3645).
 *  Undefined when the compare call fails or the response is malformed: the caller decides. */
export async function probeHeadBehindBase(
  octokit: Octokit,
  owner: string,
  repoName: string,
  baseRef: string,
  headSha: string,
): Promise<boolean | undefined> {
  try {
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo: repoName,
      basehead: `${baseRef}...${headSha}`,
    });
    const behindBy = (data as { behind_by?: unknown } | undefined)?.behind_by;
    return typeof behindBy === 'number' ? behindBy > 0 : undefined;
  } catch {
    return undefined;
  }
}
