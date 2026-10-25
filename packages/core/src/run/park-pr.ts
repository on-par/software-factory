// src/run/park-pr.ts — settle a parked run's PR: close it with the park reason, or mark it ready

import type { Octokit } from '@octokit/rest';

import type { EventKind } from '../events/kinds.js';
import { findOpenPR } from '../phases/ship.js';
import { markPrReadyWithRetry } from '../phases/ship-ready.js';
import { shortDetail } from '../phases/ship-git.js';
import { parkUnblockHint } from './park-comment.js';
import type { ParkReason } from './outcome.js';
import type { WorkKey } from '../work/work-key.js';

export type ParkedPrDisposition = {
  action: 'closed' | 'readied' | 'left' | 'none' | 'failed';
  prNumber?: number;
  detail?: string;
};

/** What a park does to its PR: the PR itself is the problem (close), the cause is outside a green PR (ready), or nothing. */
export function parkedPrAction(reason: ParkReason, greenAndChecked: boolean): 'close' | 'ready' | 'leave' {
  switch (reason) {
    case 'ci-failed':
    case 'ci-infra':
    case 'conflict':
      return 'close';
    case 'fail':
    case 'timeout':
      return greenAndChecked ? 'ready' : 'close';
    case 'escalate':
    case 'held':
    case 'config':
    case 'blocked':
    case 'ci-never-started':
    case 'all_providers_down':
    case 'sandbox-env':
    case 'check-infra':
      return greenAndChecked ? 'ready' : 'leave';
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

export function renderParkedPrComment(input: { issue: WorkKey; reason: ParkReason; branch: string }): string {
  const { issue, reason, branch } = input;
  return [
    `The factory closed this PR because the run for #${issue} parked with reason \`${reason}\`.`,
    '',
    `The branch \`${branch}\` is kept. The park state is on #${issue}.`,
    '',
    parkUnblockHint(reason, issue),
  ].join('\n');
}

export async function settleParkedPullRequest(deps: {
  octokit: Octokit;
  repo: string;
  issue: WorkKey;
  branch: string;
  reason: ParkReason;
  prNumber?: number;
  greenAndChecked?: boolean;
  log: (type: EventKind, msg: string) => void;
}): Promise<ParkedPrDisposition> {
  const { octokit, issue, branch, reason, log } = deps;
  const [owner = '', repo = ''] = deps.repo.split('/');
  let prNumber = deps.prNumber;
  try {
    if (prNumber === undefined) {
      const found = await findOpenPR(octokit, owner, repo, branch);
      if (found.status === 'absent') return { action: 'none' };
      if (found.status === 'error') {
        log('warn', `could not look up the PR for ${branch} after the park: ${found.detail}`);
        return { action: 'failed', detail: found.detail };
      }
      prNumber = found.prNumber;
    }
    const action = parkedPrAction(reason, deps.greenAndChecked ?? false);
    if (action === 'leave') return { action: 'left', prNumber };
    if (action === 'ready') {
      const flip = await markPrReadyWithRetry(octokit, owner, repo, prNumber);
      if (!flip.ok) {
        log('warn', `could not mark PR #${prNumber} ready after the run parked (${reason}): ${flip.detail}`);
        return { action: 'failed', prNumber, detail: flip.detail };
      }
      log('ship', `PR #${prNumber} marked ready for review after the run parked (${reason})`);
      return { action: 'readied', prNumber };
    }
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: renderParkedPrComment({ issue, reason, branch }),
    });
    await octokit.rest.pulls.update({ owner, repo, pull_number: prNumber, state: 'closed' });
    log('ship', `closed PR #${prNumber}: run parked (${reason}); branch ${branch} kept`);
    return { action: 'closed', prNumber };
  } catch (err) {
    const detail = shortDetail(err);
    log(
      'warn',
      `could not settle PR${prNumber === undefined ? '' : ` #${prNumber}`} after the run parked (${reason}): ${detail}`,
    );
    return { action: 'failed', ...(prNumber === undefined ? {} : { prNumber }), detail };
  }
}
