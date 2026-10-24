// packages/cli/src/cli/lane-park-comment.ts — upsert the issue park comment for a park raised outside runIssue (#3534)

import { issueNumberOf, type ParkPayload, type ParkReason, workKeyFromIssue } from '@on-par/factory-core';
import { parkPayload, publishParkComment } from '@on-par/factory-core/internal';
import type { Octokit } from '@octokit/rest';

const failure = (issue: number, detail: string): string =>
  `could not post the issue park comment for #${issue}: ${detail}`;

/** Upserts the single `factory-issue-state` comment. Fail-closed: returns the warning text
 *  (an `{ ok: false }` result or a throwing getter) instead of throwing; undefined on success. */
export async function tryPublishParkComment(
  getOctokit: () => Octokit,
  repo: string,
  worktree: string,
  readHead: () => Promise<string>,
  input: Parameters<typeof publishParkComment>[0]['input'],
): Promise<string | undefined> {
  try {
    const posted = await publishParkComment({ octokit: getOctokit(), repo, worktree, readHead, input });
    return posted.ok ? undefined : failure(issueNumberOf(input.issue), posted.error);
  } catch (err) {
    return failure(issueNumberOf(input.issue), err instanceof Error ? err.message : String(err));
  }
}

type LaneParkCommentOptions = {
  getOctokit?: () => Octokit;
  ghRepo: string;
  repoRoot: string;
  runId: string;
  lane: string;
  readParkSha: (branch: string) => Promise<string>;
};

/** Binds runLane's lane context into a fail-closed park-comment poster. Absent octokit = no-op;
 *  a failed post goes to `warn` and never changes lane flow. */
export const laneParkCommenter =
  (opts: LaneParkCommentOptions, warn: (issue: number, message: string) => void) =>
  async (issue: number, reason: ParkReason, message: string, branch?: string): Promise<void> => {
    const { getOctokit, ghRepo, repoRoot, runId, lane, readParkSha } = opts;
    if (!getOctokit) return;
    const readHead = () => (branch ? readParkSha(branch) : Promise.reject(new Error('no branch')));
    const input = { issue: workKeyFromIssue(issue), reason, message, runId, branch: branch || '-', lane, blockers: [] };
    const failed = await tryPublishParkComment(getOctokit, ghRepo, repoRoot, readHead, input);
    if (failed) warn(issue, failed);
  };

/** `parkPayload` for a park the lane raises: the lane tracks plain issue numbers, the run helpers take work keys. */
export const laneParkPayload = (
  reason: ParkReason,
  issue: number,
  lane: string | undefined,
  blockedBehind: readonly number[],
): ParkPayload => parkPayload(reason, workKeyFromIssue(issue), lane, blockedBehind);
