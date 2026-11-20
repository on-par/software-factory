import { styleText } from 'node:util';

import type { Octokit } from '@octokit/rest';
import { classifyHeadChecks, listAllCheckRuns } from '@on-par/factory-core/internal';

import { CliExitError } from './errors.js';
import type { LandJson } from './land-contract.js';
import { latestPrForBranch } from './land-merged.js';
import {
  AwaitingCiError,
  AwaitingReviewError,
  CiFailedError,
  isCiNotGreen,
  LandConflictError,
  LandFailureError,
  MergeGatedError,
} from './land-pr.js';

type LandResult = LandJson['result'];
type PrSnapshot = Pick<LandJson, 'headSha' | 'mergeable'> & { closed: boolean };
type HeadChecks = { pending: string[]; failed: string[] };
type LandFailure = { exit: number; line?: string; message?: string };
type LandReportContext = { octokit: Octokit; ghRepo: string; issue: number; json: boolean };

const CHECKS_PENDING_EXIT = 75;

export class NoOpenPrError extends LandFailureError {
  constructor(
    issue: number,
    readonly branch: string,
  ) {
    super(`no open PR for issue #${issue} (${branch})`, 1);
  }
}

function classifyLandError(err: unknown): LandResult | undefined {
  if (isCiNotGreen(err)) return 'checks_pending';
  if (err instanceof CiFailedError) return 'checks_failed';
  if (err instanceof LandConflictError) return 'conflicting';
  return undefined;
}

function describeLandFailure(issue: number, err: unknown): LandFailure {
  const result = classifyLandError(err);
  const left = (detail: string) => `⏸ PR #${(err as { prNumber?: number }).prNumber} for issue #${issue}${detail}`;
  if (err instanceof AwaitingReviewError) return { exit: 0, line: left(' awaiting human review — left open') };
  if (result === 'checks_pending') {
    return { exit: CHECKS_PENDING_EXIT, line: left(' — CI never reached a green verdict — left open, not merged') };
  }
  if (result === 'checks_failed') return { exit: 0, line: left(' has a failing CI check — left open, not merged') };
  const message = `factory: ${(err as Error).message}`;
  if (err instanceof MergeGatedError) return { exit: 4, message };
  if (result === 'conflicting') return { exit: 3, message };
  if (err instanceof LandFailureError) return { exit: err.code, message };
  return { exit: 5, message: `factory: merge failed for issue #${issue}: ${(err as Error).message}` };
}

function mergeableOf(value: boolean | null | undefined): LandJson['mergeable'] {
  if (value === true) return 'MERGEABLE';
  return value === false ? 'CONFLICTING' : 'UNKNOWN';
}

function ownerRepo(ctx: LandReportContext): [string, string] {
  const [owner = '', repo = ''] = ctx.ghRepo.split('/');
  return [owner, repo];
}

async function readPrSnapshot(ctx: LandReportContext, pr: number): Promise<PrSnapshot> {
  const [owner, repo] = ownerRepo(ctx);
  try {
    const { data } = await ctx.octokit.rest.pulls.get({ owner, repo, pull_number: pr });
    return { headSha: data.head.sha, mergeable: mergeableOf(data.mergeable), closed: data.state === 'closed' };
  } catch {
    return { headSha: null, mergeable: 'UNKNOWN', closed: false };
  }
}

async function readHeadChecks(ctx: LandReportContext, sha: string | null): Promise<HeadChecks> {
  if (!sha) return { pending: [], failed: [] };
  const [owner, repo] = ownerRepo(ctx);
  try {
    const runs = await listAllCheckRuns(ctx.octokit, owner, repo, sha, 100, 10);
    const { pending, failed } = classifyHeadChecks(
      [],
      runs.map((run) => ({ name: run.name ?? '', status: run.status ?? null, conclusion: run.conclusion ?? null })),
    );
    return { pending, failed };
  } catch {
    return { pending: [], failed: [] };
  }
}

async function buildLandJson(ctx: LandReportContext, result: LandResult, pr: number, snap: PrSnapshot) {
  const checks = await readHeadChecks(ctx, snap.headSha);
  const list = result === 'checks_failed' ? { failed: checks.failed } : { pending: checks.pending };
  const json: LandJson = { result, pr, headSha: snap.headSha, ...list, mergeable: snap.mergeable, schemaVersion: 1 };
  return JSON.stringify(json);
}

async function closedPrFor(ctx: LandReportContext, err: unknown): Promise<number | undefined> {
  if (!(err instanceof NoOpenPrError)) return undefined;
  const [owner, repo] = ownerRepo(ctx);
  const latest = await latestPrForBranch(ctx.octokit, owner, repo, err.branch).catch(() => null);
  return latest && !latest.merged ? latest.number : undefined;
}

async function failureJson(ctx: LandReportContext, err: unknown, knownPr?: number): Promise<string | undefined> {
  const pr = knownPr ?? (await closedPrFor(ctx, err));
  if (pr === undefined) return undefined;
  const snap = await readPrSnapshot(ctx, pr);
  if (err instanceof AwaitingCiError) snap.headSha ??= err.headSha;
  const result = classifyLandError(err) ?? (snap.closed ? 'closed' : undefined);
  return result ? buildLandJson(ctx, result, pr, snap) : undefined;
}

export function landReporter(ctx: LandReportContext, print = (line: string) => console.log(line)) {
  let knownPr: number | undefined;
  return {
    onPr: (pr: number) => {
      knownPr = pr;
    },
    landed: async (pr: number): Promise<void> => {
      print(styleText('green', `✅ Landed PR #${pr} for issue #${ctx.issue}`));
      if (ctx.json) print(await buildLandJson(ctx, 'merged', pr, await readPrSnapshot(ctx, pr)));
    },
    failed: async (err: unknown): Promise<void> => {
      const failure = describeLandFailure(ctx.issue, err);
      if (failure.line) print(styleText('yellow', failure.line));
      const json = ctx.json ? await failureJson(ctx, err, knownPr) : undefined;
      if (json) print(json);
      if (failure.message !== undefined) throw new CliExitError(failure.message, failure.exit);
      if (failure.exit !== 0) process.exitCode = failure.exit;
    },
  };
}
