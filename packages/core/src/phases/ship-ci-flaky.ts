import type { Octokit } from '@octokit/rest';

import type { EventKind } from '../events/kinds.js';
import { attributeCiFailure, type BaseFailingChecks, listBranchCheckResults } from '../run/ci-rework.js';
import type { CiFailureEvidence } from '../types/index.js';
import { rerunFailedJobsOnce } from '../utils/ci-failed-job-rerun.js';
import type { CiRerunBudget, InfraRerunOutcome } from '../utils/ci-watch.js';
import { shortDetail } from './ship-git.js';

const FLAKY_RERUN_SETTLE_MS = 15_000;

type FlakyRerunVerdict =
  { kind: 'skipped' } | { kind: 'rerun'; checks: string[]; baseLabel: string; outcome: InfraRerunOutcome };

export interface FlakyRerunContext {
  octokit: Octokit;
  owner: string;
  repoName: string;
  prNumber: number;
  watchRef: string;
  baseRef: string;
  evidence: CiFailureEvidence;
  rerunBudget: CiRerunBudget;
  rewatch: () => Promise<InfraRerunOutcome>;
  rerun?: (argv: readonly string[]) => Promise<{ ok: boolean }>;
  listBase?: typeof listBranchCheckResults;
  sleep?: (ms: number) => Promise<void>;
  log: (type: EventKind, msg: string) => void;
}

function checksWithNoBaseResult(evidence: CiFailureEvidence, base: BaseFailingChecks): string[] {
  if (evidence.alerts.length > 0) return [];
  const { items } = attributeCiFailure(evidence, [], base);
  const flaky = items.length > 0 && items.every((i) => i.kind === 'check' && i.baseResult === 'none');
  return flaky ? items.map((i) => i.ref) : [];
}

const SKIPPED: FlakyRerunVerdict = { kind: 'skipped' };

export async function rerunChecksWithNoBaseResult(ctx: FlakyRerunContext): Promise<FlakyRerunVerdict> {
  const { evidence, prNumber, log } = ctx;
  if (evidence.alerts.length > 0 || evidence.failingChecks.length === 0) return SKIPPED;
  try {
    const base = await (ctx.listBase ?? listBranchCheckResults)(ctx.octokit, ctx.owner, ctx.repoName, ctx.baseRef);
    const checks = checksWithNoBaseResult(evidence, base);
    if (checks.length === 0) return SKIPPED;
    const baseLabel = `${base.baseRef}@${base.baseSha.slice(0, 12)}`;
    const named = `check(s) ${checks.join(', ')}`;
    const rerun = await rerunFailedJobsOnce({
      octokit: ctx.octokit,
      owner: ctx.owner,
      repo: ctx.repoName,
      ref: ctx.watchRef,
      checkNames: checks,
      rerun: ctx.rerun,
      rerunBudget: ctx.rerunBudget,
    });
    if (rerun.status === 'skipped') {
      log('ship', `CI for PR #${prNumber}: ${named} had no result on base ${baseLabel}; not rerun: ${rerun.reason}`);
      return SKIPPED;
    }
    const runs = rerun.runIds.join(', ');
    if (rerun.status === 'rerun-failed') {
      log('warn', `CI for PR #${prNumber}: could not rerun failed job(s) in run(s) ${runs} for ${named}`);
      return SKIPPED;
    }
    log(
      'ship',
      `CI for PR #${prNumber}: ${named} had no result on base ${baseLabel}; reran failed job(s) in run(s) ${runs} on ${rerun.headSha.slice(0, 12)} once before any rework`,
    );
    await (ctx.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(FLAKY_RERUN_SETTLE_MS);
    return { kind: 'rerun', checks, baseLabel, outcome: await ctx.rewatch() };
  } catch (err) {
    log('warn', `CI flaky-check rerun for PR #${prNumber} failed: ${shortDetail(err)}; continuing without it`);
    return SKIPPED;
  }
}
