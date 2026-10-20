// packages/core/src/run/stack-restack.ts — ADR-0161 (#3368): rebase open stack slices above a squash-merged slice.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';

import { renderStackOrderLine, replaceStackOrderLine, retargetedStackPosition } from '../phases/stack-order.js';
import { stackSliceBranch, withSliceState, type SlicePlan } from '../readiness/slice-plan.js';
import { execGit } from '../utils/git-exec.js';

export interface StackRestackOptions {
  /** Main checkout; a short-lived detached worktree is added from it. */
  repoRoot: string;
  octokit: Octokit;
  /** owner/name */
  repo: string;
  /** Current trusted slice plan. */
  plan: SlicePlan;
  /** The slice that was squash-merged. */
  mergedIndex: number;
  mergedPrNumber: number;
  savePlan: (plan: SlicePlan) => Promise<void>;
  /** Default 'origin'. */
  remote?: string;
  /** Default 'main'. */
  baseBranch?: string;
}

export type StackRestackOutcome =
  | { status: 'nothing'; reason: string }
  | {
      status: 'restacked';
      plan: SlicePlan;
      slices: Array<{ index: number; prNumber: number; branch: string; headSha: string }>;
      retargeted: boolean;
    }
  | { status: 'park'; reason: string; index: number; prNumber?: number; files: string[] };

interface Candidate {
  index: number;
  prNumber: number;
  branch: string;
  recorded: string;
}

function detail(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown } | null;
  const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : '';
  if (stderr) return stderr;
  return err instanceof Error ? err.message : String(err);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execGit(args, { cwd })).stdout.trim();
}

async function succeeds(cwd: string, ...args: string[]): Promise<boolean> {
  try {
    await execGit(args, { cwd });
    return true;
  } catch {
    return false;
  }
}

/** Rebases every open slice above a squash-merged slice, bottom-up with `--onto`, and pushes them in one leased atomic push. */
export async function restackAfterSquashMerge(opts: StackRestackOptions): Promise<StackRestackOutcome> {
  const { repoRoot, octokit, plan, mergedIndex, mergedPrNumber, savePlan } = opts;
  const remote = opts.remote ?? 'origin';
  const base = opts.baseBranch ?? 'main';
  const [owner, repoName] = opts.repo.split('/') as [string, string];
  const n = plan.slices.length;
  const park = (reason: string, index: number, prNumber?: number, files: string[] = []): StackRestackOutcome => ({
    status: 'park',
    reason,
    index,
    ...(prNumber === undefined ? {} : { prNumber }),
    files,
  });

  const open = plan.slices
    .filter((s) => s.index > mergedIndex && s.state === 'pr-open')
    .sort((a, b) => a.index - b.index);
  if (open.length === 0) return { status: 'nothing', reason: `no open slice above slice ${mergedIndex}` };

  const candidates: Candidate[] = [];
  for (const s of open) {
    const label = `slice ${s.index}/${n}`;
    if (s.prNumber === undefined) return park(`${label} has no recorded PR number; refusing to restack`, s.index);
    const branch = s.branch ?? stackSliceBranch(plan.issue, s.index);
    if (branch !== stackSliceBranch(plan.issue, s.index)) {
      return park(
        `${label} PR #${s.prNumber} branch ${branch} is not factory-owned; refusing to force-push`,
        s.index,
        s.prNumber,
      );
    }
    if (s.headSha === undefined) {
      return park(`${label} PR #${s.prNumber} has no recorded head SHA; refusing to force-push`, s.index, s.prNumber);
    }
    candidates.push({ index: s.index, prNumber: s.prNumber, branch, recorded: s.headSha });
  }

  let mergedHead: string;
  try {
    mergedHead = (await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: mergedPrNumber })).data.head.sha;
    await git(repoRoot, 'fetch', remote, `+refs/heads/${base}:refs/remotes/${remote}/${base}`);
    for (const c of candidates) {
      await git(repoRoot, 'fetch', remote, `+refs/heads/${c.branch}:refs/remotes/${remote}/${c.branch}`);
    }
    if (!(await succeeds(repoRoot, 'cat-file', '-e', `${mergedHead}^{commit}`))) {
      await succeeds(repoRoot, 'fetch', remote, `+refs/pull/${mergedPrNumber}/head`);
    }
  } catch (err) {
    return park(
      `restack of slices above slice ${mergedIndex} could not fetch: ${detail(err)}`,
      candidates[0]!.index,
      candidates[0]!.prNumber,
    );
  }

  const remoteRef = (c: Candidate): string => `refs/remotes/${remote}/${c.branch}`;
  // Contiguous run starting at the lowest slice that still holds the merged head.
  if (!(await succeeds(repoRoot, 'merge-base', '--is-ancestor', mergedHead, remoteRef(candidates[0]!)))) {
    return {
      status: 'nothing',
      reason: `slice ${candidates[0]!.index} no longer holds slice ${mergedIndex}'s commits`,
    };
  }
  const run: Candidate[] = [];
  for (const c of candidates) {
    if (c.index !== candidates[0]!.index + run.length) break;
    run.push(c);
  }

  const oldHeads: string[] = [];
  for (const c of run) {
    const label = `slice ${c.index}/${n}`;
    let head: string;
    try {
      head = await git(repoRoot, 'rev-parse', remoteRef(c));
    } catch (err) {
      return park(`${label} PR #${c.prNumber} head could not be read: ${detail(err)}`, c.index, c.prNumber);
    }
    if (head !== c.recorded) {
      return park(
        `${label} PR #${c.prNumber} branch ${c.branch} moved since the factory recorded ${c.recorded}; a human may have pushed`,
        c.index,
        c.prNumber,
      );
    }
    oldHeads.push(head);
  }

  const tmp = await mkdtemp(join(tmpdir(), 'factory-restack-'));
  const newHeads: string[] = [];
  try {
    await git(repoRoot, 'worktree', 'add', '--detach', tmp, `${remote}/${base}`);
    for (const [at, c] of run.entries()) {
      const label = `slice ${c.index}/${n}`;
      const newBase = at === 0 ? `${remote}/${base}` : newHeads[at - 1]!;
      const upstream = at === 0 ? mergedHead : oldHeads[at - 1]!;
      try {
        await git(tmp, 'checkout', '--detach', oldHeads[at]!);
        await git(tmp, 'rebase', '--onto', newBase, upstream);
      } catch (err) {
        let files: string[] = [];
        try {
          files = (await git(tmp, 'diff', '--name-only', '--diff-filter=U')).split('\n').filter(Boolean);
        } catch {
          // best effort
        }
        await succeeds(tmp, 'rebase', '--abort');
        const why = files.length > 0 ? `conflicted in: ${files.join(', ')}` : `failed: ${detail(err)}`;
        return park(
          `restack of ${label} PR #${c.prNumber} onto ${newBase} ${why}; nothing was pushed`,
          c.index,
          c.prNumber,
          files,
        );
      }
      newHeads.push(await git(tmp, 'rev-parse', 'HEAD'));
    }

    try {
      await git(
        tmp,
        'push',
        '--atomic',
        remote,
        ...run.map((c) => `--force-with-lease=refs/heads/${c.branch}:${c.recorded}`),
        ...run.map((c, at) => `${newHeads[at]}:refs/heads/${c.branch}`),
      );
    } catch (err) {
      const text = detail(err);
      const named = run.find((c) => text.includes(c.branch)) ?? run[0]!;
      return park(
        `force-push of slice ${named.index}/${n} PR #${named.prNumber} (${named.branch}) was refused (lease on ${named.recorded}): ${text}; nothing was pushed`,
        named.index,
        named.prNumber,
      );
    }
  } catch (err) {
    return park(`restack of slices above slice ${mergedIndex} failed: ${detail(err)}`, run[0]!.index, run[0]!.prNumber);
  } finally {
    await succeeds(repoRoot, 'worktree', 'remove', '--force', tmp);
    await rm(tmp, { recursive: true, force: true });
  }

  const first = run[0]!;
  let next = plan;
  for (const [at, c] of run.entries())
    next = withSliceState(next, c.index, 'pr-open', c.prNumber, c.branch, newHeads[at]);
  let retargeted = false;
  try {
    const { data } = await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: first.prNumber });
    retargeted = data.base.ref !== base;
    const body = replaceStackOrderLine(
      data.body ?? '',
      renderStackOrderLine(retargetedStackPosition(next, first.index)),
    );
    if (retargeted || body !== (data.body ?? '')) {
      await octokit.rest.pulls.update({
        owner,
        repo: repoName,
        pull_number: first.prNumber,
        body,
        ...(retargeted ? { base } : {}),
      });
    }
  } catch (err) {
    return park(
      `slices restacked and pushed but retargeting slice ${first.index}/${n} PR #${first.prNumber} failed: ${detail(err)}`,
      first.index,
      first.prNumber,
    );
  }
  try {
    await savePlan(next);
  } catch (err) {
    return park(
      `slices restacked and pushed but recording the new head SHAs failed: ${detail(err)}`,
      first.index,
      first.prNumber,
    );
  }
  return {
    status: 'restacked',
    plan: next,
    slices: run.map((c, at) => ({ index: c.index, prNumber: c.prNumber, branch: c.branch, headSha: newHeads[at]! })),
    retargeted,
  };
}
