// packages/core/src/run/prerequisite-restack.ts — cross-issue stacks (#3916): rebase a stacked PR onto main after its
// prerequisite squash-merged, or onto the prerequisite's new head after it moved. Reuses ADR-0161's rebase/push.

import type { Octokit } from '@octokit/rest';

import { prerequisiteStackOrder, renderPrerequisiteStackLine, replaceStackOrderLine } from '../phases/stack-order.js';
import type { PrerequisiteStackTarget } from '../queue/prerequisite-stack.js';
import { execGit } from '../utils/git-exec.js';
import { gitErrorDetail, rebaseAndPushStack } from './stack-rebase.js';

export interface PrerequisiteRestackOptions {
  /** Main checkout; a short-lived detached worktree is added from it. */
  repoRoot: string;
  octokit: Octokit;
  /** owner/name */
  repo: string;
  /** The stacked PR. */
  prNumber: number;
  branch: string;
  /** The stacked branch head the factory last saw; the push lease and the ownership check. */
  recordedHead: string;
  /** The prerequisite PR and head the stacked branch was built on (from the PR body marker). */
  stackedOn: PrerequisiteStackTarget;
  onto: { kind: 'main'; mergedHead: string } | { kind: 'prerequisite'; newHead: string };
  /** Default 'origin'. */
  remote?: string;
  /** Default 'main'. */
  baseBranch?: string;
}

export type PrerequisiteRestackOutcome =
  { status: 'restacked'; headSha: string; retargeted: boolean } | { status: 'park'; reason: string; files: string[] };

const PREREQUISITE_MARKER_PREFIX = '<!-- factory:prerequisite-stack ';

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execGit(args, { cwd })).stdout.trim();
}

/** Rebases the stacked branch `--onto` main (prerequisite merged) or the prerequisite's new head, then updates the PR. */
export async function restackOnPrerequisite(opts: PrerequisiteRestackOptions): Promise<PrerequisiteRestackOutcome> {
  const { repoRoot, octokit, prNumber, branch, recordedHead, stackedOn, onto } = opts;
  const remote = opts.remote ?? 'origin';
  const base = opts.baseBranch ?? 'main';
  const [owner, repoName] = opts.repo.split('/') as [string, string];
  const park = (reason: string, files: string[] = []): PrerequisiteRestackOutcome => ({
    status: 'park',
    reason,
    files,
  });
  const label = `PR #${prNumber} (${branch})`;

  let startBase: string;
  try {
    await git(repoRoot, 'fetch', remote, `+refs/heads/${base}:refs/remotes/${remote}/${base}`);
    await git(repoRoot, 'fetch', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`);
    if (onto.kind === 'prerequisite') {
      await git(
        repoRoot,
        'fetch',
        remote,
        `+refs/heads/${stackedOn.branch}:refs/remotes/${remote}/${stackedOn.branch}`,
      );
      await git(repoRoot, 'cat-file', '-e', `${onto.newHead}^{commit}`);
      startBase = onto.newHead;
    } else {
      startBase = `${remote}/${base}`;
    }
    const head = await git(repoRoot, 'rev-parse', `refs/remotes/${remote}/${branch}`);
    if (head !== recordedHead) {
      return park(
        `${label} moved since the factory recorded ${recordedHead}; a human may have pushed — not restacking onto prerequisite PR #${stackedOn.prNumber}`,
      );
    }
  } catch (err) {
    return park(
      `restack of ${label} onto prerequisite PR #${stackedOn.prNumber} could not fetch: ${gitErrorDetail(err)}`,
    );
  }

  const rebased = await rebaseAndPushStack({
    repoRoot,
    remote,
    startBase,
    layers: [{ branch, recordedHead, upstream: stackedOn.headSha }],
  });
  if (!rebased.ok) {
    return park(`restack of ${label} ${rebased.reason}`, rebased.files);
  }
  const headSha = rebased.newHeads[0]!;

  try {
    const { data } = await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: prNumber });
    const merged = onto.kind === 'main';
    const retargeted = merged && data.base.ref !== base;
    const without = (data.body ?? '')
      .split('\n')
      .filter((l) => !l.startsWith(PREREQUISITE_MARKER_PREFIX))
      .join('\n');
    const issue = Number(/^factory\/(\d+)-/.exec(branch)?.[1]);
    const body = merged
      ? replaceStackOrderLine(without, renderPrerequisiteStackLine({ prerequisite: stackedOn, issue, base }))
      : replaceStackOrderLine(
          without,
          prerequisiteStackOrder({ ...stackedOn, headSha: onto.newHead }, issue, stackedOn.branch)!,
        );
    if (retargeted || body !== (data.body ?? '')) {
      await octokit.rest.pulls.update({
        owner,
        repo: repoName,
        pull_number: prNumber,
        body,
        ...(retargeted ? { base } : {}),
      });
    }
    return { status: 'restacked', headSha, retargeted };
  } catch (err) {
    return park(`${label} restacked and pushed but updating the PR failed: ${gitErrorDetail(err)}`);
  }
}
