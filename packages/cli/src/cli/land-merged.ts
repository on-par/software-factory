// packages/cli/src/cli/land-merged.ts — merged-state lookups for a factory branch's PR (split from land.ts)

import type { Octokit } from '@octokit/rest';

export async function latestPrForBranch(
  octokit: Octokit,
  owner: string,
  repoName: string,
  branch: string,
): Promise<{ number: number; merged: boolean } | null> {
  const { data: prs } = await octokit.rest.pulls.list({
    owner,
    repo: repoName,
    state: 'all',
    head: `${owner}:${branch}`,
  });
  if (prs.length === 0) return null;
  // Branch names get reused across runs; PR numbers only increase, so the highest-numbered PR is the current one
  // (a stale merged PR under the same name must not make a new open PR look merged).
  const latest = prs.reduce((newest: any, pr: any) => (pr.number > newest.number ? pr : newest));
  return { number: latest.number, merged: Boolean(latest.merged_at) };
}

export async function isPrMerged(octokit: Octokit, owner: string, repoName: string, branch: string): Promise<boolean> {
  return (await latestPrForBranch(octokit, owner, repoName, branch))?.merged ?? false;
}
