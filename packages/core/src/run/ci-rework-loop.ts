// packages/core/src/run/ci-rework-loop.ts — SHIP with a bounded CI rework loop (#2816)

import {
  type checkPhase as checkPhaseDefault,
  type CheckPhaseResult,
  reworkWorker as reworkWorkerDefault,
} from '../phases/check.js';
import type { PlanResult } from '../phases/plan.js';
import { stackPositionFor } from '../phases/stack-order.js';
import type { shipPhase as shipPhaseDefault, ShipResult } from '../phases/ship.js';
import type { ReviewRouting } from '../review/routing.js';
import type { CiFailingCheck, CiFailureEvidence, CiSuppressionFinding, Constitution } from '../types/index.js';
import { collectFailingJobLogs as collectFailingJobLogsDefault } from '../utils/ci-evidence.js';
import {
  attributableCodeqlAlerts,
  attributeCiFailure,
  type BaseFailingChecks,
  CI_CHECK_REWORK_INSTRUCTIONS,
  CI_REWORK_INSTRUCTIONS,
  ciCheckReworkSummary,
  ciReworkSummary,
  listBaseFailingChecks as listBaseFailingChecksDefault,
  listPrChangedFiles as listPrChangedFilesDefault,
  needsBaseChecks,
  resolveMaxCiReworkRounds,
} from './ci-rework.js';
import {
  describeSuppression,
  mergeBaseIntoWorktree as mergeBaseIntoWorktreeDefault,
  readReworkDiff as readReworkDiffDefault,
  readWorktreeHead as readWorktreeHeadDefault,
  scanReworkDiff,
} from './ci-suppression-guard.js';
import { reworkRouteFor, type BuildRoute, type ParkReason, type RunOutcome } from './outcome.js';
import type { RunPorts, RunRequest } from './run-issue.js';
import type { RunPolicy } from './policy.js';
import { shipParkReason } from './ship-park.js';

/** Injectable seams for the CI rework loop; RunPorts extends this. */
export interface CiReworkPorts {
  /** BUILD rework worker used for CI rework rounds; defaults to check.ts's reworkWorker. */
  reworkWorker?: typeof reworkWorkerDefault;
  /** Lists a PR's changed files for CI alert attribution; defaults to the GitHub REST lister. */
  listPrChangedFiles?: typeof listPrChangedFilesDefault;
  /** Lists failing check names on the PR base branch's latest commit (#2817); defaults to the GitHub REST lister. */
  listBaseFailingChecks?: typeof listBaseFailingChecksDefault;
  /** Reads the worktree HEAD before a CI rework round (#2818); defaults to git rev-parse. */
  readWorktreeHead?: typeof readWorktreeHeadDefault;
  /** Reads the diff a CI rework round produced (#2818); defaults to git diff <before> HEAD. */
  readReworkDiff?: typeof readReworkDiffDefault;
  /** Fetches and merges origin/<PR base> into the worktree before a non-CodeQL CI rework round (#3537); no push. */
  mergeBaseIntoWorktree?: typeof mergeBaseIntoWorktreeDefault;
  /** Downloads the failing Actions jobs' log tails for a non-CodeQL CI rework round (#3537). */
  collectFailingJobLogs?: typeof collectFailingJobLogsDefault;
}

export interface CiReworkLoopContext {
  request: RunRequest;
  ports: RunPorts;
  shipPhase: typeof shipPhaseDefault;
  checkPhase: typeof checkPhaseDefault;
  /** The options the first CHECK ran with; reused verbatim for each re-CHECK. */
  checkOpts: Parameters<typeof checkPhaseDefault>[0];
  check: Awaited<ReturnType<typeof checkPhaseDefault>>;
  constitution: Constitution | null;
  appPort: number | undefined;
  appBaseUrl: string | undefined;
  onPgid: (pgid: number) => void;
  runId: string;
  /** Records a re-CHECK's summary, asserts the budget and interprets a failure like the first CHECK (#3435). */
  onRecheck: (recheck: CheckPhaseResult, round: number) => Promise<RunOutcome | undefined>;
}

export interface CiReworkShipInputs {
  builtRoute: BuildRoute;
  builtModel: string;
  reviewRouting: ReviewRouting | undefined;
  pinNote: string | undefined;
  planSlice: PlanResult['slice'];
  /** PR presentation policy, kept on every CI-rework re-entry. */
  pr?: RunPolicy['pr'];
}

export interface ShipWithCiReworkResult {
  ship: ShipResult;
  /** Set when a re-CHECK ended the run; its terminal event is already logged. */
  outcome?: RunOutcome;
  /** Set when the run must park: a SHIP that did not succeed, or a suppression attempt. */
  parked?: {
    reason: ParkReason;
    message: string;
    checkFailure?: { failureSignature: string; failingChecks: string[] };
    ciFailure?: CiFailureEvidence;
  };
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Failing checks the PR caused (not failing on base) that are not CodeQL, in ship.ciFailure order. */
function attributableNonCodeqlChecks(
  evidence: CiFailureEvidence | undefined,
  items: readonly { kind: string; ref: string; attributable: boolean }[],
): CiFailingCheck[] {
  if (!evidence) return [];
  const names = new Set(items.filter((i) => i.kind === 'check' && i.attributable).map((i) => i.ref));
  return evidence.failingChecks.filter((c) => names.has(c.name) && !/codeql/i.test(c.name));
}

const guardError = (match: string): CiSuppressionFinding => ({
  kind: 'path',
  rule: 'guard-error',
  file: '(unknown)',
  match,
});

/**
 * Runs SHIP. When the CI watch fails on CodeQL alerts in files the PR changed, feeds them to the
 * BUILD rework worker, re-runs CHECK and re-enters SHIP on the same PR, up to
 * resolveMaxCiReworkRounds() rounds — a counter separate from CHECK's own rework rounds.
 * When there are no such alerts but a non-CodeQL check fails that is not failing on the PR base (#3537),
 * each round first merges origin/<base> into the worktree (a conflict parks `conflict`) and feeds the
 * failing jobs' log tails to the worker, under the same budget and guard.
 * After each rework round the committed diff is scanned for suppression attempts (#2818); any hit,
 * or an unreadable diff, parks ci-failed before the re-CHECK, push or re-watch.
 */
export async function shipWithCiRework(
  ctx: CiReworkLoopContext,
  inputs: CiReworkShipInputs,
): Promise<ShipWithCiReworkResult> {
  const { request, ports, shipPhase, checkPhase, check } = ctx;
  const rework = ports.reworkWorker ?? reworkWorkerDefault;
  const listChanged = ports.listPrChangedFiles ?? listPrChangedFilesDefault;
  const listBase = ports.listBaseFailingChecks ?? listBaseFailingChecksDefault;
  const readHead = ports.readWorktreeHead ?? readWorktreeHeadDefault;
  const readDiff = ports.readReworkDiff ?? readReworkDiffDefault;
  const mergeBase = ports.mergeBaseIntoWorktree ?? mergeBaseIntoWorktreeDefault;
  const collectLogs = ports.collectFailingJobLogs ?? collectFailingJobLogsDefault;
  const { builtRoute, builtModel, planSlice } = inputs;
  const log = ports.events();
  const shipOpts = {
    issue: request.issue,
    repo: request.repo,
    worktree: ports.workspace.path,
    branch: request.branch,
    recordedRemoteSha: ports.workspace.remoteBranch?.sha,
    octokit: ports.octokit,
    watchCI: !request.skipCI,
    ...(request.ciDeadlineMs === undefined ? {} : { ciDeadlineMs: request.ciDeadlineMs }),
    ...(inputs.pr?.draft ? { draft: true } : {}),
    footer: inputs.pr?.footer,
    log: ports.events('ship'),
    approvalGate: request.options.interactive ? ports.createApprovalGate?.() : undefined,
    specPath: request.specPath,
    eventsFile: request.eventsFile,
    startedAt: request.startedAt,
    logsDir: request.logsDir,
    work: request.work,
    laneId: request.lane,
    reviewRouting: inputs.reviewRouting,
    ...(inputs.pinNote ? { pinNotes: [inputs.pinNote] } : {}),
    slice: planSlice ? { index: planSlice.index, count: planSlice.plan.slices.length } : undefined,
    ...(request.sizeGateMode === 'stack' && planSlice
      ? { stack: stackPositionFor(planSlice.plan, planSlice.index, request.parentBaseRef) }
      : {}),
  };
  let ship = await shipPhase({ ...shipOpts, checkSummary: check.summary, reworkRounds: check.reworkRounds });

  const [owner, repoName] = request.repo.split('/');
  const maxRounds = resolveMaxCiReworkRounds();
  let rounds = 0;
  let lastCiFailure = ship.ciFailure;
  let suffix = '';
  while (!ship.ok && ship.ciOutcome === 'failure' && ship.prNumber !== undefined) {
    lastCiFailure = ship.ciFailure ?? lastCiFailure;
    let changed: string[];
    try {
      changed = await listChanged(ports.octokit, owner, repoName, ship.prNumber);
    } catch (err) {
      const msg = `could not list PR #${ship.prNumber} files for CI attribution: ${errorMessage(err)}`;
      ports.events('ship')('ship', msg);
      break;
    }
    let base: BaseFailingChecks | undefined;
    if (needsBaseChecks(ship.ciFailure)) {
      try {
        base = await listBase(ports.octokit, owner, repoName, ship.prNumber);
      } catch (err) {
        ports.events('ship')('ship', `could not read base checks for PR #${ship.prNumber}: ${errorMessage(err)}`);
      }
    }
    const attribution = attributeCiFailure(ship.ciFailure, changed, base);
    if (ship.ciFailure) lastCiFailure = { ...ship.ciFailure, attribution };
    if (attribution.baseline) {
      const note = 'baseline: no CI failure is attributable to this PR';
      suffix = ` — ${note}`;
      ports.events('ship')('ship', `${note} (PR #${ship.prNumber})`);
      break;
    }
    const attributable = attributableCodeqlAlerts(ship.ciFailure, changed);
    const failingChecks =
      attributable.length === 0 && base ? attributableNonCodeqlChecks(ship.ciFailure, attribution.items) : [];
    if (attributable.length === 0 && failingChecks.length === 0) break;
    if (rounds >= maxRounds) {
      suffix = ` — CI rework budget exhausted after ${rounds} round${rounds === 1 ? '' : 's'}`;
      break;
    }
    rounds++;
    const skipped = attribution.items.filter((i) => !i.attributable).map((i) => i.ref);
    const what =
      attributable.length > 0
        ? `${attributable.length} attributable CodeQL alert(s)`
        : `attributable failing check(s) ${failingChecks.map((c) => c.name).join(', ')}`;
    log(
      'rework',
      `CI rework round ${rounds}/${maxRounds}: ${what} on PR #${ship.prNumber}` +
        (skipped.length > 0 ? `; non-attributable: ${skipped.join(', ')}` : ''),
      lastCiFailure ? { ciFailure: lastCiFailure } : undefined,
    );
    const suppressionPark = (findings: CiSuppressionFinding[]): ShipWithCiReworkResult => {
      const described = describeSuppression(findings);
      ports.events('ship')('ship', `${described} after CI rework round ${rounds} (PR #${ship.prNumber})`);
      const message = ship.reason
        ? `ship phase failed: ${ship.reason} — ${described}`
        : `ship phase failed — ${described}`;
      const base = lastCiFailure ?? { failingChecks: [], alerts: [], truncated: false };
      return { ship, parked: { reason: 'ci-failed', message, ciFailure: { ...base, suppressionAttempt: findings } } };
    };
    let logs: Awaited<ReturnType<typeof collectLogs>> = { jobLogs: [], errors: [] };
    if (attributable.length === 0 && base) {
      const merge = await mergeBase(ports.workspace.path, base.baseRef);
      if (!merge.ok && merge.conflict) {
        const message = `merge of origin/${base.baseRef} into ${request.branch} conflicts before CI rework round ${rounds}: ${merge.paths.join(', ')}`;
        ports.events('ship')('ship', message);
        return { ship, parked: { reason: 'conflict', message, ciFailure: lastCiFailure } };
      }
      if (!merge.ok) {
        suffix = ` — could not merge origin/${base.baseRef}: ${merge.message}`;
        break;
      }
      if (merge.merged) {
        ports.events('ship')(
          'ship',
          `merged origin/${base.baseRef} into ${request.branch} before CI rework round ${rounds}`,
        );
      }
      logs = await collectLogs({
        octokit: ports.octokit,
        owner,
        repo: repoName,
        ref: ship.headSha ?? request.branch,
        checkNames: failingChecks.map((c) => c.name),
      });
      lastCiFailure = {
        ...(lastCiFailure ?? { failingChecks: [], alerts: [], truncated: false }),
        jobLogs: logs.jobLogs,
      };
    }
    let beforeSha: string;
    try {
      beforeSha = await readHead(ports.workspace.path);
    } catch (err) {
      return suppressionPark([guardError(`could not read the worktree HEAD: ${errorMessage(err)}`)]);
    }
    const worked = await rework({
      issue: request.issue,
      worktree: ports.workspace.path,
      specPath: request.specPath,
      summary:
        attributable.length > 0
          ? ciReworkSummary(attributable)
          : ciCheckReworkSummary(failingChecks, logs.jobLogs, logs.errors),
      constitution: ctx.constitution,
      router: ports.router,
      log: ports.events('build'),
      buildTimeoutSeconds: request.timeouts.build,
      sandbox: request.sandboxPolicy,
      appPort: ctx.appPort,
      appBaseUrl: ctx.appBaseUrl,
      onPgid: ctx.onPgid,
      ...reworkRouteFor(builtRoute, builtModel),
      runId: ctx.runId,
      onWorkerResult: ctx.checkOpts.onWorkerResult,
      extraInstructions: attributable.length > 0 ? CI_REWORK_INSTRUCTIONS : CI_CHECK_REWORK_INSTRUCTIONS,
    });
    if (!worked.modelCompleted) {
      suffix = ' — CI rework worker never ran';
      break;
    }
    let findings: CiSuppressionFinding[];
    try {
      findings = scanReworkDiff(await readDiff(ports.workspace.path, beforeSha));
    } catch (err) {
      findings = [guardError(`could not read the CI rework diff: ${errorMessage(err)}`)];
    }
    if (findings.length > 0) return suppressionPark(findings);
    const recheck = await checkPhase(ctx.checkOpts);
    const ended = await ctx.onRecheck(recheck, rounds);
    if (ended) return { ship, outcome: ended };
    ship = await shipPhase({
      ...shipOpts,
      checkSummary: recheck.summary,
      reworkRounds: recheck.reworkRounds,
      reentry: { prNumber: ship.prNumber, previousHeadSha: ship.headSha },
    });
  }
  if (ship.ok) return { ship };
  const message = ship.denied
    ? `ship denied: ${ship.deniedReason}`
    : ship.reason
      ? `ship phase failed: ${ship.reason}${suffix}`
      : `ship phase failed${suffix}`;
  return { ship, parked: { reason: shipParkReason(ship), message, ciFailure: lastCiFailure ?? ship.ciFailure } };
}
