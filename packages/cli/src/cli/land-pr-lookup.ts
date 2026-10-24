// packages/cli/src/cli/land-pr-lookup.ts — highest-numbered PR under a head branch (#3291)

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
  // Ship-it branch names get reused across separate runs for the same issue
  // (e.g. a "verify-and-close" pass recreates the exact branch name an
  // earlier, already-merged PR used) — GitHub PR numbers only increase, so
  // the highest-numbered PR under this head is always the current one.
  // Checking "was ANY PR ever merged under this branch name" (the old
  // `state: 'closed'` + `.some()` behavior) matched the stale prior PR and
  // falsely reported a brand-new, still-open PR under the same name as
  // merged — waitForMerge then logged "landed" and skipped calling land(),
  // leaving the real PR open forever while the lane believed it was done.
  const latest = prs.reduce((newest: any, pr: any) => (pr.number > newest.number ? pr : newest));
  return { number: latest.number, merged: Boolean(latest.merged_at) };
}

export async function isPrMerged(octokit: Octokit, owner: string, repoName: string, branch: string): Promise<boolean> {
  return (await latestPrForBranch(octokit, owner, repoName, branch))?.merged ?? false;
}
