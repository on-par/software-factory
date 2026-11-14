// packages/core/src/phases/ship-finish.ts — SHIP preview gate, ready flip and final result

import type { PreviewCheckResult } from '../checkers/preview-check.js';
import type { VisualProofResult } from '../checkers/visual-proof.js';
import { publishPreviewReceipt } from '../checkers/preview-receipt.js';
import type { InfraRerunOutcome } from '../utils/ci-watch.js';
import type { CommandRunner } from './ship-git.js';
import type { ShipPhaseOptions } from './ship-options.js';
import { previewFailureReason, runPreviewGate } from './ship-preview.js';
import { markPrReadyWithRetry } from './ship-ready.js';
import { runVisualProofGate, visualProofFailureReason } from './ship-visual-proof.js';
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

  let resolvedSha = headSha;
  const currentSha = async (): Promise<string> => {
    resolvedSha ??= (await run('git rev-parse HEAD', { cwd: worktree })).stdout.trim();
    return resolvedSha;
  };

  let previewCheck: PreviewCheckResult | undefined;
  if (opts.previewGate) {
    const sha = await currentSha();
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

  let visualProof: VisualProofResult | undefined;
  if (opts.visualProofGate) {
    const sha = await currentSha();
    visualProof = await runVisualProofGate(opts.visualProofGate, { prNumber, headSha: sha }, { log, ciPending });
    const nonPass = visualProof.status !== 'pass' && visualProof.status !== 'not-required';
    if (nonPass && opts.visualProofMode === 'advisory') {
      // Advisory mode (#4047): the block and status already say so; never fail SHIP or park.
      log('warn', `${visualProofFailureReason(prNumber, visualProof)} (advisory: not blocking SHIP)`);
    } else if (nonPass) {
      return {
        ok: false,
        prNumber,
        reason: visualProofFailureReason(prNumber, visualProof),
        visualProof,
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
    ...(opts.draft ? { draftReason: 'requested' as const } : ciPending ? { draftReason: 'ci-pending' as const } : {}),
    ...(previewCheck ? { previewCheck } : {}),
    ...(visualProof ? { visualProof } : {}),
  };
}
