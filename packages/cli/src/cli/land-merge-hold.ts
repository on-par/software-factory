// packages/cli/src/cli/land-merge-hold.ts — helpers for the opt-in `--merge` hooks in waitForMerge (#3905)

import type { Octokit } from '@octokit/rest';

import { MergeGatedError } from './land-pr.js';

/** #3905: the hold raised when `--merge` meets a gated label and must not poll for a human. */
export function gatedHold(label: string, issue: number, prNumber: number | undefined): MergeGatedError {
  return new MergeGatedError(`auto-merge blocked by ${label} — awaiting human approval`, issue, prNumber ?? 0, label);
}

/** #3905: an issueless (brief) run reads labels on the PR, found by branch. */
export async function prNumberForBranch(
  lookup: (
    octokit: Octokit,
    owner: string,
    repo: string,
    branch: string,
  ) => Promise<{ number: number } | null | undefined>,
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<number> {
  const found = await lookup(octokit, owner, repo, branch);
  if (!found) throw new Error(`no PR found for ${branch}`);
  return found.number;
}
