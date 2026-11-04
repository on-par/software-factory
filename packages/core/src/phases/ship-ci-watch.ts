import type { Octokit } from '@octokit/rest';

import type { EventKind } from '../events/kinds.js';
import { collectCiFailureEvidence } from '../utils/ci-evidence.js';
import { DEFAULT_CI_DEADLINE_MS, type InfraRerunOutcome, watchChecksWithInfraRerun } from '../utils/ci-watch.js';
import { shortDetail } from './ship-git.js';
import type { ShipResult } from './ship-types.js';

export async function watchShipCi(ctx: {
  octokit: Octokit;
  owner: string;
  repo: string;
  repoName: string;
  prNumber: number;
  watchRef: string;
  headSha: string | undefined;
  rerun?: (argv: readonly string[]) => Promise<{ ok: boolean }>;
  deadlineMs?: number;
  baseBranch: string;
  ciWatch?: typeof watchChecksWithInfraRerun;
  log: (type: EventKind, msg: string) => void;
}): Promise<{ ciOutcome?: InfraRerunOutcome; ciWatchError?: string; result?: ShipResult }> {
  const { octokit, owner, repo, repoName, prNumber, watchRef, headSha, log } = ctx;
  const ciDeadlineMs = ctx.deadlineMs ?? DEFAULT_CI_DEADLINE_MS;
  let ciOutcome: InfraRerunOutcome | undefined;
  let ciWatchError: string | undefined;
  log('ship', `Watching CI for PR #${prNumber}`);
  try {
    ciOutcome = await (ctx.ciWatch ?? watchChecksWithInfraRerun)({
      octokit,
      owner,
      repo: repoName,
      ref: watchRef,
      rerun: ctx.rerun,
      deadlineMs: ciDeadlineMs,
      probeNoCi: true,
      requiredChecks: { branch: ctx.baseBranch },
      onProgress: ({ total, completed, pending, remainingMs, waitingFor }) =>
        log(
          'ship',
          waitingFor?.length
            ? `CI for PR #${prNumber}: waiting for required check${waitingFor.length > 1 ? 's' : ''} ${waitingFor.map((w) => `${w.name} (${w.state})`).join(', ')}, ${Math.ceil(remainingMs / 60_000)} min left`
            : `CI for PR #${prNumber}: ${pending} pending, ${completed}/${total} completed, ${Math.ceil(remainingMs / 60_000)} min left before the CI timeout`,
        ),
      onNoChecks: ({ sha, defaultBranch }) =>
        log(
          'ship',
          `no CI configured on ${repo} (no workflow files on ${sha} and no checks or statuses on recent ${defaultBranch} commits); skipping CI wait`,
        ),
      onRescued: ({ headSha, runIds }) =>
        log(
          'ci-rescued',
          `CI rescued for PR #${prNumber}: reran infra-failed run(s) ${runIds.join(', ')} on ${headSha.slice(0, 12)} once and the re-watch is green`,
        ),
      onRescueFailed: ({ headSha, runIds, outcome }) =>
        log(
          'ci-rescue-failed',
          `CI rescue failed for PR #${prNumber}: reran infra-failed run(s) ${runIds.join(', ')} on ${headSha.slice(0, 12)} once and the re-watch ended ${outcome}`,
        ),
    });
    if (ciOutcome === 'success') log('ship', `CI green for PR #${prNumber}`);
    else if (ciOutcome === 'failure') {
      const reason = `CI failed for PR #${prNumber}`;
      log('ship', reason);
      const ciFailure = await collectCiFailureEvidence({ octokit, owner, repo: repoName, ref: watchRef, prNumber });
      return {
        ciOutcome,
        result: { ok: false, prNumber, reason, ciOutcome, ciFailure, ...(headSha ? { headSha } : {}) },
      };
    } else if (ciOutcome === 'infra-failure') {
      const reason = `CI failed again for infrastructure reasons for PR #${prNumber} after one rerun`;
      log('ship', reason);
      return { ciOutcome, result: { ok: false, prNumber, reason, ciOutcome } };
    } else if (ciOutcome === 'timeout') {
      log(
        'ship',
        `CI pending for PR #${prNumber}: CI did not finish within ${ciDeadlineMs / 60_000} min; leaving PR as draft`,
      );
    }
  } catch (err) {
    ciWatchError = shortDetail(err);
    log('warn', `CI watch for PR #${prNumber} failed: ${ciWatchError}; treating CI as pending`);
  }
  return { ciOutcome, ciWatchError };
}
