// packages/cli/src/cli/lane-park-comment.ts — upsert the issue park comment for a park raised outside runIssue (#3534)

import { publishParkComment } from '@on-par/factory-core/internal';
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
    return posted.ok ? undefined : failure(input.issue, posted.error);
  } catch (err) {
    return failure(input.issue, err instanceof Error ? err.message : String(err));
  }
}
