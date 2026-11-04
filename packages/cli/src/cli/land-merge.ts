import type { Octokit } from '@octokit/rest';
import { shellEscape } from '@on-par/factory-core/internal';
import { landRuntime } from './land-runtime.js';

export type CommandRunner = (command: string, options?: { cwd?: string; timeout?: number }) => Promise<unknown>;

export async function defaultListIssueLabels(
  octokit: Octokit,
  owner: string,
  repo: string,
  issue: number,
): Promise<string[]> {
  const { data } = await octokit.rest.issues.listLabelsOnIssue({ owner, repo, issue_number: issue });
  return data.map((label) => label.name);
}

export async function squashMergeAndDelete(
  octokit: Octokit,
  owner: string,
  repoName: string,
  branch: string,
  prNumber: number,
  opts: { admin?: boolean; run?: CommandRunner; sha?: string; signal?: AbortSignal } = {},
): Promise<void> {
  opts.signal?.throwIfAborted();
  const { sha } = opts;
  // #3916: a PR stacked on a prerequisite's factory branch is never landed; it must be retargeted to main first.
  const { data: pull } = await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: prNumber });
  if (pull.base.ref.startsWith('factory/')) {
    throw new Error(`refusing to merge PR #${prNumber}: its base is ${pull.base.ref}, not main (stacked PR)`);
  }
  if (opts.admin) {
    const run = opts.run ?? landRuntime().shellOps.exec;
    const pin = sha ? ` --match-head-commit ${shellEscape(sha)}` : '';
    await run(
      `gh pr merge ${prNumber} --repo ${shellEscape(`${owner}/${repoName}`)} --admin --squash --delete-branch${pin}`,
    );
    return;
  }

  await octokit.rest.pulls.merge({
    owner,
    repo: repoName,
    pull_number: prNumber,
    merge_method: 'squash',
    ...(sha ? { sha } : {}),
  });
  await octokit.rest.git.deleteRef({ owner, repo: repoName, ref: `heads/${branch}` }).catch(() => {});
}
