import type { Octokit } from '@octokit/rest';

import { renderStackOrderLine, replaceStackOrderLine, retargetedStackPosition } from '../phases/stack-order.js';
import { stackSliceBranch, withSliceState, type SlicePlan } from '../readiness/slice-plan.js';
import { execGit } from '../utils/git-exec.js';
import { gitErrorDetail, rebaseAndPushStack } from './stack-rebase.js';

export interface StackRestackOptions {
  repoRoot: string;
  octokit: Octokit;
  repo: string;
  plan: SlicePlan;
  mergedIndex: number;
  mergedPrNumber: number;
  savePlan: (plan: SlicePlan) => Promise<void>;
  remote?: string;
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
  recorded?: string;
}

const detail = gitErrorDetail;

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
    candidates.push({
      index: s.index,
      prNumber: s.prNumber,
      branch,
      ...(s.headSha !== undefined ? { recorded: s.headSha } : {}),
    });
  }

  let mergedHead: string;
  try {
    mergedHead = (await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: mergedPrNumber })).data.head.sha;
    await git(repoRoot, 'fetch', remote, `+refs/heads/${base}:refs/remotes/${remote}/${base}`);
    for (const c of candidates) {
      await git(repoRoot, 'fetch', remote, `+refs/heads/${c.branch}:refs/remotes/${remote}/${c.branch}`);
    }
    if (!(await succeeds(repoRoot, 'cat-file', '-e', `${mergedHead}^{commit}`))) {
      await git(repoRoot, 'fetch', remote, `+refs/pull/${mergedPrNumber}/head`);
      if (!(await succeeds(repoRoot, 'cat-file', '-e', `${mergedHead}^{commit}`))) {
        return park(
          `merged head ${mergedHead} unavailable after fetching refs/pull/${mergedPrNumber}/head`,
          candidates[0]!.index,
          candidates[0]!.prNumber,
        );
      }
    }
  } catch (err) {
    return park(
      `restack of slices above slice ${mergedIndex} could not fetch: ${detail(err)}`,
      candidates[0]!.index,
      candidates[0]!.prNumber,
    );
  }

  const remoteRef = (c: Candidate): string => `refs/remotes/${remote}/${c.branch}`;
  let holdsMerged = true;
  try {
    await git(repoRoot, 'merge-base', '--is-ancestor', mergedHead, remoteRef(candidates[0]!));
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 1) {
      return park(
        `could not check whether slice ${candidates[0]!.index} holds slice ${mergedIndex}'s commits: ${detail(err)}`,
        candidates[0]!.index,
        candidates[0]!.prNumber,
      );
    }
    holdsMerged = false;
  }
  if (!holdsMerged) {
    return {
      status: 'nothing',
      reason: `slice ${candidates[0]!.index} no longer holds slice ${mergedIndex}'s commits`,
    };
  }
  const contiguousRun: Candidate[] = [];
  for (const c of candidates) {
    if (c.index !== candidates[0]!.index + contiguousRun.length) break;
    contiguousRun.push(c);
  }

  const oldHeads: string[] = [];
  for (const c of contiguousRun) {
    const label = `slice ${c.index}/${n}`;
    if (c.recorded === undefined) {
      return park(`${label} PR #${c.prNumber} has no recorded head SHA; refusing to force-push`, c.index, c.prNumber);
    }
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

  const rebased = await rebaseAndPushStack({
    repoRoot,
    remote,
    startBase: `${remote}/${base}`,
    layers: contiguousRun.map((c, at) => ({
      branch: c.branch,
      recordedHead: oldHeads[at]!,
      upstream: at === 0 ? mergedHead : oldHeads[at - 1]!,
    })),
  });
  if (!rebased.ok) {
    const c = contiguousRun[rebased.at]!;
    const label = `slice ${c.index}/${n}`;
    if (rebased.phase === 'setup') {
      return park(
        `restack of slices above slice ${mergedIndex} failed: ${rebased.reason}`,
        contiguousRun[0]!.index,
        contiguousRun[0]!.prNumber,
      );
    }
    if (rebased.phase === 'rebase') {
      return park(`restack of ${label} PR #${c.prNumber} ${rebased.reason}`, c.index, c.prNumber, rebased.files);
    }
    return park(`force-push of ${label} PR #${c.prNumber} ${rebased.reason}`, c.index, c.prNumber);
  }
  const newHeads = rebased.newHeads;

  const first = contiguousRun[0]!;
  let next = plan;
  for (const [at, c] of contiguousRun.entries())
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
    slices: contiguousRun.map((c, at) => ({
      index: c.index,
      prNumber: c.prNumber,
      branch: c.branch,
      headSha: newHeads[at]!,
    })),
    retargeted,
  };
}
