// packages/core/src/phases/ship-finish.ts — SHIP preview gate, ready flip and final result

import type { PreviewCheckResult } from '../checkers/preview-check.js';
import { publishPreviewReceipt } from '../checkers/preview-receipt.js';
import type { InfraRerunOutcome } from '../utils/ci-watch.js';
import type { CommandRunner } from './ship-git.js';
import type { ShipPhaseOptions } from './ship-options.js';
import { previewFailureReason, runPreviewGate } from './ship-preview.js';
import { markPrReadyWithRetry } from './ship-ready.js';
import type { ShipResult } from './ship-types.js';

export async function finishShip(ctx: {
  opts: ShipPhaseOptions;
  run: CommandRunner;
  owner: string;
  repoName: string;
  prNumber: number;
  headSha?: string;
  ciOutcome?: InfraRerunOutcome;
  ciWatchError?: string;
}): Promise<ShipResult> {
  const { opts, run, owner, repoName, prNumber, headSha, ciOutcome, ciWatchError } = ctx;
  const { octokit, worktree, log } = opts;
  const ciPending = ciOutcome === 'timeout' || ciWatchError !== undefined;

  let previewCheck: PreviewCheckResult | undefined;
  if (opts.previewGate) {
    const sha = headSha ?? (await run('git rev-parse HEAD', { cwd: worktree })).stdout.trim();
    const publish = (n: number, r: PreviewCheckResult) => publishPreviewReceipt(octokit, owner, repoName, n, r);
    const gateCtx = { log, ciPending, publish, ...(opts.logsDir ? { logsDir: opts.logsDir } : {}) };
    previewCheck = await runPreviewGate(opts.previewGate, { prNumber, headSha: sha }, gateCtx);
    if (previewCheck.status !== 'pass') {
      return {
        ok: false,
        prNumber,
        reason: previewFailureReason(prNumber, previewCheck),
        previewCheck,
        headSha: sha,
        ...(ciOutcome ? { ciOutcome } : {}),
        ...(ciPending ? { ciPending: true, draft: true } : {}),
      };
    }
  }

  if (ciWatchError !== undefined) {
    const reason = `CI unknown for PR #${prNumber}: the CI watch failed (${ciWatchError}); leaving PR as draft`;
    log('ship', reason);
    return { ok: false, prNumber, reason, ciPending: true, draft: true, ...(headSha ? { headSha } : {}) };
  }

  // Mark ready for review (if draft). REST pulls.update ignores `draft`;
  // undrafting requires the markPullRequestReadyForReview GraphQL mutation.
  if (opts.draft || ciPending) {
    try {
      const { data: pr } = await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: prNumber });
      if (!pr.draft) log('ship', `PR #${prNumber} is already open and not a draft; draft mode leaves it as is`);
    } catch {}
  } else {
    const flip = await markPrReadyWithRetry(octokit, owner, repoName, prNumber);
    if (!flip.ok) {
      const reason = `could not mark PR #${prNumber} ready for review after one retry: ${flip.detail}`;
      log('warn', reason);
      return {
        ok: false,
        prNumber,
        reason,
        ...(ciOutcome === undefined ? {} : { ciOutcome }),
        ...(headSha ? { headSha } : {}),
      };
    }
  }

  const noChecks = ciOutcome === 'no-checks' ? ' (CI skipped: no checks found)' : '';
  const readyLabel = opts.draft || ciPending ? `left as draft${ciPending ? ' (CI pending)' : ''}` : 'ready for review';
  log('ready', `PR #${prNumber} ${readyLabel}${noChecks}`);
  return {
    ok: true,
    prNumber,
    ...(ciOutcome === undefined ? {} : { ciOutcome }),
    ...(headSha ? { headSha } : {}),
    ...(opts.draft || ciPending ? { draft: true } : {}),
    ...(ciPending ? { ciPending: true } : {}),
    ...(previewCheck ? { previewCheck } : {}),
  };
}
