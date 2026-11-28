import type { Octokit } from '@octokit/rest';

import type { EventKind } from '../events/kinds.js';
import type { CiFailureEvidence } from '../types/index.js';
import { collectCiFailureEvidence } from '../utils/ci-evidence.js';
import {
  type CiRerunBudget,
  DEFAULT_CI_DEADLINE_MS,
  DEFAULT_RERUN_BUDGET,
  type InfraRerunOutcome,
  type InfraRerunWatchOptions,
  watchChecksWithInfraRerun,
} from '../utils/ci-watch.js';
import type { listBranchCheckResults } from '../run/ci-rework.js';
import { rerunChecksWithNoBaseResult } from './ship-ci-flaky.js';
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
  prBase?: string;
  ciWatch?: typeof watchChecksWithInfraRerun;
  rerunBudget?: CiRerunBudget;
  listBase?: typeof listBranchCheckResults;
  sleep?: (ms: number) => Promise<void>;
  log: (type: EventKind, msg: string) => void;
}): Promise<{ ciOutcome?: InfraRerunOutcome; ciWatchError?: string; result?: ShipResult }> {
  const { octokit, owner, repo, repoName, prNumber, watchRef, headSha, log } = ctx;
  const ciDeadlineMs = ctx.deadlineMs ?? DEFAULT_CI_DEADLINE_MS;
  const rerunBudget = ctx.rerunBudget ?? DEFAULT_RERUN_BUDGET;
  const watch = ctx.ciWatch ?? watchChecksWithInfraRerun;
  const collect = () => collectCiFailureEvidence({ octokit, owner, repo: repoName, ref: watchRef, prNumber });
  const failed = (reason: string, ciFailure: CiFailureEvidence, extra: Partial<ShipResult> = {}) => ({
    ciOutcome: 'failure' as const,
    result: {
      ok: false,
      prNumber,
      reason,
      ciOutcome: 'failure' as const,
      ciFailure,
      ...(headSha ? { headSha } : {}),
      ...extra,
    },
  });
  let ciOutcome: InfraRerunOutcome | undefined;
  let ciWatchError: string | undefined;
  log('ship', `Watching CI for PR #${prNumber}`);
  try {
    const watchOpts: InfraRerunWatchOptions = {
      octokit,
      owner,
      repo: repoName,
      ref: watchRef,
      rerun: ctx.rerun,
      rerunBudget,
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
    };
    ciOutcome = await watch(watchOpts);
    if (ciOutcome === 'failure') {
      const reason = `CI failed for PR #${prNumber}`;
      log('ship', reason);
      const ciFailure = await collect();
      const flaky = await rerunChecksWithNoBaseResult({
        octokit,
        owner,
        repoName,
        prNumber,
        watchRef,
        baseRef: ctx.prBase ?? ctx.baseBranch,
        evidence: ciFailure,
        rerunBudget,
        rewatch: () => watch(watchOpts),
        rerun: ctx.rerun,
        listBase: ctx.listBase,
        sleep: ctx.sleep,
        log,
      });
      if (flaky.kind === 'skipped') return failed(reason, ciFailure);
      const named = `check(s) ${flaky.checks.join(', ')}`;
      ciOutcome = flaky.outcome;
      if (ciOutcome === 'success') {
        log(
          'ci-flaky-rerun-green',
          `CI for PR #${prNumber}: ${named} had no result on base ${flaky.baseLabel} and went green after one rerun; shipping without rework`,
        );
      } else if (ciOutcome === 'failure' || ciOutcome === 'infra-failure') {
        const stillRed = `${reason}: ${named} had no result on base ${flaky.baseLabel} and still failed after one rerun`;
        log('ship', stillRed);
        return failed(stillRed, await collect(), { ciFlaky: { checks: flaky.checks } });
      }
    }
    if (ciOutcome === 'success') log('ship', `CI green for PR #${prNumber}`);
    else if (ciOutcome === 'infra-failure') {
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
