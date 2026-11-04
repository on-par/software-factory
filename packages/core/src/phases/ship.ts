// src/phases/ship.ts — SHIP phase: create/verify PR, mark ready for review

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

import { withLifecycle } from '../bus/index.js';
import { type InfraRerunOutcome } from '../utils/ci-watch.js';
import { GITHUB_ISSUE_SOURCE } from '../work/github-issue.js';
import { requestShipApproval } from './ship-approval.js';
import { pushNewBranch } from './ship-branch-push.js';
import { watchShipCi } from './ship-ci-watch.js';
import { syncExistingPr } from './ship-existing-pr.js';
import { postEvidenceComment } from './ship-evidence-comment.js';
import { finishShip } from './ship-finish.js';
import { openOrFindPr } from './ship-open-pr.js';
import { SHIP_BASE_BRANCH, type ShipPhaseOptions } from './ship-options.js';
import { findMergedPR, findOpenPR } from './ship-pr-lookup.js';
import { pushReentry } from './ship-reentry.js';
import type { PrLookup, ShipResult } from './ship-types.js';
import { lazyWalkthrough } from './ship-walkthrough.js';

export { findMergedPR, findOpenPR };
export type { PrLookup, ShipResult };

const exec = promisify(execCb);

export async function shipPhase(opts: ShipPhaseOptions): Promise<ShipResult> {
  return withLifecycle(
    {
      bus: opts.bus,
      phase: 'ship',
      laneId: opts.laneId,
      issueId: opts.issue,
      worktreePath: opts.worktree,
      log: opts.log,
    },
    () => shipPhaseImpl(opts),
    (r) => r.ok,
    (r) =>
      r.ok
        ? `ship complete${r.prNumber === undefined ? '' : ` (PR #${r.prNumber})`}`
        : `ship failed${(r.deniedReason ?? r.reason) === undefined ? '' : `: ${r.deniedReason ?? r.reason}`}`,
  );
}

async function shipPhaseImpl(opts: ShipPhaseOptions): Promise<ShipResult> {
  const {
    issue,
    repo,
    worktree,
    branch,
    octokit,
    watchCI = true,
    log,
    run = exec,
    rerun,
    approvalGate,
    checkSummary,
  } = opts;
  const [owner, repoName] = repo.split('/');
  const inlineWork = opts.work && opts.work.kind !== GITHUB_ISSUE_SOURCE ? opts.work : undefined;
  const stack = inlineWork ? undefined : opts.stack;
  const base = stack?.base ?? opts.baseBranch ?? SHIP_BASE_BRANCH;
  const walkthrough = lazyWalkthrough(run, worktree, { ...opts, base }, log);

  if (approvalGate) {
    const denied = await requestShipApproval({ approvalGate, issue, branch, worktree, base, run, checkSummary, log });
    if (denied) return denied;
  }

  // Check if a PR already exists (claude route may have created one)
  const openLookup = await findOpenPR(octokit, owner, repoName, branch);
  if (openLookup.status === 'error') {
    const reason = `could not determine whether an open PR exists for ${branch} (${openLookup.detail})`;
    log('ship', `${reason} — aborting before PR creation`);
    return { ok: false, reason };
  }
  let prNumber: number | undefined = openLookup.status === 'found' ? openLookup.prNumber : undefined;
  const reentry = opts.reentry;
  let watchRef = branch;
  let headSha: string | undefined;

  if (reentry) {
    const pushed = await pushReentry({ run, worktree, branch, prNumber, reentry, log });
    if ('stop' in pushed) return pushed.stop;
    ({ watchRef, headSha } = pushed);
  } else if (prNumber) {
    const stop = await syncExistingPr({ run, worktree, branch, prNumber, log });
    if (stop) return stop;
  }

  if (!prNumber) {
    const stop = await pushNewBranch({
      run,
      worktree,
      branch,
      issue: inlineWork ? undefined : issue,
      octokit,
      owner,
      repoName,
      recordedRemoteSha: opts.recordedRemoteSha,
      log,
    });
    if (stop) return stop;
    const opened = await openOrFindPr({ opts, inlineWork, stack, base, owner, repoName, walkthrough });
    if ('stop' in opened) return opened.stop;
    prNumber = opened.prNumber;
  }

  if (!prNumber) {
    const reason = `Could not create or find PR for ${branch}`;
    log('fail', reason);
    return { ok: false, reason };
  }

  if (!reentry && opts.evidenceComment)
    await postEvidenceComment({ opts, run, owner, repoName, prNumber, walkthrough });

  let ciOutcome: InfraRerunOutcome | undefined;
  let ciWatchError: string | undefined;
  if (watchCI) {
    const ci = await watchShipCi({
      octokit,
      owner,
      repo,
      repoName,
      prNumber,
      watchRef,
      headSha,
      rerun,
      deadlineMs: opts.ciDeadlineMs,
      baseBranch: SHIP_BASE_BRANCH,
      ciWatch: opts.ciWatch,
      log,
    });
    if (ci.result) return ci.result;
    ({ ciOutcome, ciWatchError } = ci);
  }

  return finishShip({ opts, run, owner, repoName, prNumber, headSha, ciOutcome, ciWatchError });
}
