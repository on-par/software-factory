// packages/core/src/run/ci-rework-loop.ts — SHIP with a bounded CI rework loop (#2816)

import { PREVIEW_REWORK_INSTRUCTIONS, previewReworkSummary, runPreviewCheck } from '../checkers/preview-check.js';
import { createOctokitPreviewGitHub } from '../checkers/preview-source-octokit.js';
import { attachVisualProof, publishVisualProof } from '../checkers/visual-proof-attach.js';
import { classifyVisualProof, runVisualProofCapture } from '../checkers/visual-proof.js';
import type { PreviewConfig } from '../config/preview-section.js';
import { loadRepoConfig } from '../config/repo.js';
import type { VisualProofConfig } from '../config/visual-proof-section.js';
import { parseDesignArtifact } from '../design/index.js';
import { readSpec } from '../spec/index.js';
import type { VisualProofResult } from '../checkers/visual-proof.js';
import type { VisualProofGate } from '../phases/ship-visual-proof.js';
import { workKeyFromIssue } from '../work/work-key.js';
import {
  type checkPhase as checkPhaseDefault,
  type CheckPhaseResult,
  reworkWorker as reworkWorkerDefault,
} from '../phases/check.js';
import type { PlanResult } from '../phases/plan.js';
import { claimGuardedRunner } from '../phases/ship-git.js';
import { stackPositionFor } from '../phases/stack-order.js';
import type { shipPhase as shipPhaseDefault, ShipResult } from '../phases/ship.js';
import type { ReviewRouting } from '../review/routing.js';
import type {
  CiFailingCheck,
  CiFailureEvidence,
  CiJobLogExcerpt,
  CiSuppressionFinding,
  Constitution,
} from '../types/index.js';
import { collectFailingJobLogs as collectFailingJobLogsDefault } from '../utils/ci-evidence.js';
import {
  attributableCodeqlAlerts,
  attributeByJobLogs,
  attributeCiFailure,
  type BaseCodeqlAlerts,
  type BaseFailingChecks,
  CI_CHECK_REWORK_INSTRUCTIONS,
  CI_REWORK_INSTRUCTIONS,
  ciCheckReworkSummary,
  ciReworkSummary,
  listBaseCodeqlAlerts as listBaseCodeqlAlertsDefault,
  listBaseFailingChecks as listBaseFailingChecksDefault,
  listPrChangedFiles as listPrChangedFilesDefault,
  needsBaseAlerts,
  needsBaseChecks,
  resolveMaxCiReworkRounds,
} from './ci-rework.js';
import { renderCiFailureNote } from './ci-failure-note.js';
import { type CiReworkReentry, type CiReworkRoundPlan, runCiReworkRound } from './ci-rework-round.js';
import {
  describeSuppression,
  mergeBaseIntoWorktree as mergeBaseIntoWorktreeDefault,
  readReworkDiff as readReworkDiffDefault,
  readWorktreeHead as readWorktreeHeadDefault,
} from './ci-suppression-guard.js';
import type { BuildRoute, ParkReason, RunOutcome } from './outcome.js';
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
  /** Lists open CodeQL alerts on the PR base branch for alert attribution (#3712); defaults to the GitHub REST lister. */
  listBaseCodeqlAlerts?: typeof listBaseCodeqlAlertsDefault;
  /** Reads the worktree HEAD before a CI rework round (#2818); defaults to git rev-parse. */
  readWorktreeHead?: typeof readWorktreeHeadDefault;
  /** Reads the diff a CI rework round produced (#2818); defaults to git diff <before> HEAD. */
  readReworkDiff?: typeof readReworkDiffDefault;
  /** Fetches and merges origin/<PR base> into the worktree before a non-CodeQL CI rework round (#3537); no push. */
  mergeBaseIntoWorktree?: typeof mergeBaseIntoWorktreeDefault;
  /** Downloads the failing Actions jobs' log tails for a non-CodeQL CI rework round (#3537). */
  collectFailingJobLogs?: typeof collectFailingJobLogsDefault;
  /** Aborts when the lane loses this issue's claim lease (#3146): phase boundaries, push, PR creation and merge refuse to run. */
  claimSignal?: AbortSignal;
  loadPreviewConfig?: (worktree: string) => PreviewConfig | undefined;
  /** Reads the trusted `visualProof` section for the SHIP visual proof gate (#2232); defaults to the repo config. */
  loadVisualProofConfig?: (worktree: string) => VisualProofConfig | undefined;
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

const isPreviewRework = (ship: ShipResult): boolean =>
  !!ship.previewCheck && ship.previewCheck.status !== 'pass' && !ship.ciPending;

const loadPreviewConfigDefault = (worktree: string): PreviewConfig | undefined => loadRepoConfig(worktree)?.preview;

const loadVisualProofConfigDefault = (worktree: string): VisualProofConfig | undefined =>
  loadRepoConfig(worktree)?.visualProof;

/** Screenshot routes the frozen plan's evidence plan names; a missing spec yields no routes; `error` is set when it or its design block cannot be read. */
async function readPlanScreenshotRoutes(specPath: string | undefined): Promise<{ routes: string[]; error?: string }> {
  if (!specPath) return { routes: [] };
  try {
    const { artifact } = parseDesignArtifact((await readSpec(specPath)).data);
    return { routes: (artifact?.evidencePlan ?? []).flatMap((e) => (e.kind === 'screenshot' ? [e.route] : [])) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { routes: [] };
    const detail = err instanceof Error ? err.message : String(err);
    return { routes: [], error: `could not read the frozen plan's evidencePlan: ${detail}` };
  }
}

/**
 * Runs SHIP. When the CI watch fails on CodeQL alerts the PR introduced (on changed files, or not open on base), feeds them to the
 * BUILD rework worker, re-runs CHECK and re-enters SHIP on the same PR, up to
 * resolveMaxCiReworkRounds() rounds — a counter separate from CHECK's own rework rounds.
 * When there are no such alerts but a non-CodeQL check fails that is not failing on the PR base (#3537),
 * each round first merges origin/<base> into the worktree (a conflict parks `conflict`) and feeds the
 * failing jobs' log tails to the worker, under the same budget and guard.
 * After each rework round the committed diff is scanned for suppression attempts (#2818); any hit,
 * or an unreadable diff, parks ci-failed before the re-CHECK, push or re-watch.
 * A check also failing on base whose log names a file the PR changed is attributable too (#3998). A baseline or
 * budget-exhausted park appends a note naming each failing check, its run link and the files and commits it flagged;
 * the park leaves the PR open.
 */
export async function shipWithCiRework(
  ctx: CiReworkLoopContext,
  inputs: CiReworkShipInputs,
): Promise<ShipWithCiReworkResult> {
  const { request, ports, shipPhase, check } = ctx;
  const rework = ports.reworkWorker ?? reworkWorkerDefault;
  const listChanged = ports.listPrChangedFiles ?? listPrChangedFilesDefault;
  const listBase = ports.listBaseFailingChecks ?? listBaseFailingChecksDefault;
  const listBaseAlerts = ports.listBaseCodeqlAlerts ?? listBaseCodeqlAlertsDefault;
  const readHead = ports.readWorktreeHead ?? readWorktreeHeadDefault;
  const readDiff = ports.readReworkDiff ?? readReworkDiffDefault;
  const mergeBase = ports.mergeBaseIntoWorktree ?? mergeBaseIntoWorktreeDefault;
  const collectLogs = ports.collectFailingJobLogs ?? collectFailingJobLogsDefault;
  const { builtRoute, builtModel, planSlice } = inputs;
  const log = ports.events();
  const [owner, repoName] = request.repo.split('/');
  const previewConfig = (ports.loadPreviewConfig ?? loadPreviewConfigDefault)(ports.workspace.path);
  const previewGate = previewConfig
    ? (pr: { prNumber: number; headSha: string }) =>
        runPreviewCheck({
          config: previewConfig,
          github: createOctokitPreviewGitHub(ports.octokit),
          owner,
          repo: repoName,
          prNumber: pr.prNumber,
          headSha: pr.headSha,
          worktree: ports.workspace.path,
          logsDir: request.logsDir,
          onPgid: ctx.onPgid,
        })
    : undefined;
  const visualProofConfig = (ports.loadVisualProofConfig ?? loadVisualProofConfigDefault)(ports.workspace.path);
  const { routes: planRoutes, error: planRoutesError } = await readPlanScreenshotRoutes(request.specPath);
  // No section at all stays `required`: plan screenshot entries then fail with the
  // "no visualProof section" diagnostic. Only an explicit `mode: off` skips the gate (#4047).
  const visualProofMode = visualProofConfig?.mode ?? 'required';
  if (visualProofMode === 'off') ports.events('ship')('ship', 'visual proof is off by config (visualProof.mode: off)');
  const visualProofGate: VisualProofGate | undefined =
    visualProofMode !== 'off' && (visualProofConfig || planRoutes.length > 0 || planRoutesError)
      ? async (pr) => {
          if (planRoutesError) throw new Error(planRoutesError);
          const changedFiles = await listChanged(ports.octokit, owner, repoName, pr.prNumber);
          const requirement = classifyVisualProof({ changedFiles, config: visualProofConfig, planRoutes });
          const base = { headSha: pr.headSha, runId: ctx.runId, captures: [] };
          if (!requirement.required) return { status: 'not-required', ...base };
          let result: VisualProofResult = visualProofConfig
            ? await runVisualProofCapture({
                requirement,
                qa: loadRepoConfig(ports.workspace.path)?.qa ?? null,
                config: visualProofConfig,
                port: ctx.appPort,
                headSha: pr.headSha,
                runId: ctx.runId,
                worktree: ports.workspace.path,
                logsDir: request.logsDir,
                onPgid: ctx.onPgid,
              })
            : { status: 'fail', ...base, diagnostic: requirement.diagnostic };
          if (result.status === 'pass' && visualProofConfig) {
            const target = { owner, repo: repoName, prNumber: pr.prNumber, branch: request.branch };
            result = await attachVisualProof(
              ports.octokit,
              { ...target, evidenceBranch: visualProofConfig.evidenceBranch },
              result,
            );
          }
          await publishVisualProof(
            ports.octokit,
            { owner, repo: repoName, prNumber: pr.prNumber },
            result,
            visualProofMode,
          );
          return result;
        }
      : undefined;
  const shipOpts = {
    issue: workKeyFromIssue(request.issue),
    repo: request.repo,
    worktree: ports.workspace.path,
    branch: request.branch,
    recordedRemoteSha: ports.workspace.remoteBranch?.sha,
    octokit: ports.octokit,
    watchCI: !request.skipCI,
    syncMain: true,
    ...(request.ciDeadlineMs === undefined ? {} : { ciDeadlineMs: request.ciDeadlineMs }),
    ...(inputs.pr?.draft ? { draft: true } : {}),
    footer: inputs.pr?.footer,
    ...(inputs.pr?.walkthrough ? { walkthrough: inputs.pr.walkthrough } : {}),
    ...(inputs.pr?.evidenceComment ? { evidenceComment: true } : {}),
    log: ports.events('ship'),
    approvalGate: request.options.interactive ? ports.createApprovalGate?.() : undefined,
    specPath: request.specPath,
    eventsFile: request.eventsFile,
    startedAt: request.startedAt,
    logsDir: request.logsDir,
    work: request.work,
    ...(ports.claimSignal ? { run: claimGuardedRunner(ports.claimSignal) } : {}),
    ...(previewGate ? { previewGate } : {}),
    ...(visualProofGate ? { visualProofGate } : {}),
    ...(visualProofGate && visualProofMode === 'advisory' ? { visualProofMode } : {}),
    laneId: request.lane,
    reviewRouting: inputs.reviewRouting,
    ...(inputs.pinNote ? { pinNotes: [inputs.pinNote] } : {}),
    slice: planSlice ? { index: planSlice.index, count: planSlice.plan.slices.length } : undefined,
    ...(request.parentBaseRef !== undefined && request.sizeGateMode !== 'stack'
      ? {
          baseBranch: request.parentBaseRef.replace(/^origin\//, ''),
          ...(request.prerequisiteStack ? { prerequisiteStack: request.prerequisiteStack } : {}),
        }
      : {}),
    ...(request.sizeGateMode === 'stack' && planSlice
      ? { stack: stackPositionFor(planSlice.plan, planSlice.index, request.parentBaseRef) }
      : {}),
  };
  ports.claimSignal?.throwIfAborted();
  let ship = await shipPhase({ ...shipOpts, checkSummary: check.summary, reworkRounds: check.reworkRounds });
  ports.claimSignal?.throwIfAborted();

  const maxRounds = resolveMaxCiReworkRounds();
  let rounds = 0;
  let lastCiFailure = ship.ciFailure;
  let suffix = '';
  let diagnose = false;
  const suppressionPark = (findings: CiSuppressionFinding[]): ShipWithCiReworkResult => {
    const described = describeSuppression(findings);
    ports.events('ship')('ship', `${described} after CI rework round ${rounds} (PR #${ship.prNumber})`);
    const message = ship.reason
      ? `ship phase failed: ${ship.reason} — ${described}`
      : `ship phase failed — ${described}`;
    const base = lastCiFailure ?? { failingChecks: [], alerts: [], truncated: false };
    return { ship, parked: { reason: 'ci-failed', message, ciFailure: { ...base, suppressionAttempt: findings } } };
  };
  const roundPorts = {
    ctx,
    rework,
    readHead,
    readDiff,
    builtRoute,
    builtModel,
    reship: (recheck: CheckPhaseResult, reentry: CiReworkReentry) =>
      shipPhase({ ...shipOpts, checkSummary: recheck.summary, reworkRounds: recheck.reworkRounds, reentry }),
  };
  while (!ship.ok && ship.prNumber !== undefined && (ship.ciOutcome === 'failure' || isPreviewRework(ship))) {
    let plan: CiReworkRoundPlan & { label: string };
    if (ship.previewCheck && isPreviewRework(ship)) {
      if (rounds >= maxRounds) {
        suffix = ` — preview rework budget exhausted after ${rounds} round${rounds === 1 ? '' : 's'}`;
        break;
      }
      rounds++;
      log(
        'rework',
        `CI rework round ${rounds}/${maxRounds}: preview check ${ship.previewCheck.status} on PR #${ship.prNumber}`,
      );
      plan = {
        label: 'preview',
        round: rounds,
        reentry: { prNumber: ship.prNumber, previousHeadSha: ship.headSha },
        summary: {
          failures: 1,
          passes: 0,
          skips: 0,
          total: 1,
          results: [{ checker: 'preview_check', result: 'FAIL', details: previewReworkSummary(ship.previewCheck) }],
        },
        extraInstructions: PREVIEW_REWORK_INSTRUCTIONS,
      };
    } else {
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
      let baseAlerts: BaseCodeqlAlerts | undefined;
      if (needsBaseAlerts(ship.ciFailure, changed)) {
        try {
          baseAlerts = await listBaseAlerts(ports.octokit, owner, repoName, ship.prNumber);
        } catch (err) {
          ports.events('ship')(
            'ship',
            `could not read base CodeQL alerts for PR #${ship.prNumber}: ${errorMessage(err)}`,
          );
        }
      }
      let attribution = attributeCiFailure(ship.ciFailure, changed, base, baseAlerts);
      let attributionLogs: CiJobLogExcerpt[] = [];
      const suspect = new Set(attribution.items.filter((i) => i.kind === 'check' && !i.attributable).map((i) => i.ref));
      const logCandidates = (ship.ciFailure?.failingChecks ?? [])
        .filter((c) => suspect.has(c.name) && !/codeql/i.test(c.name))
        .map((c) => c.name);
      if (logCandidates.length > 0) {
        const found = await collectLogs({
          octokit: ports.octokit,
          owner,
          repo: repoName,
          ref: ship.headSha ?? request.branch,
          checkNames: logCandidates,
          changedFiles: changed,
        });
        attributionLogs = found.jobLogs;
        attribution = attributeByJobLogs(attribution, attributionLogs, ship.ciFailure, changed);
      }
      if (ship.ciFailure) {
        lastCiFailure = {
          ...ship.ciFailure,
          attribution,
          ...(attributionLogs.length > 0 ? { jobLogs: attributionLogs } : {}),
        };
      }
      if (attribution.baseline) {
        const note = 'baseline: no CI failure is attributable to this PR';
        suffix = ` — ${note}`;
        diagnose = true;
        ports.events('ship')('ship', `${note} (PR #${ship.prNumber})`);
        break;
      }
      const attributable = attributableCodeqlAlerts(ship.ciFailure, changed, baseAlerts);
      const failingChecks =
        attributable.length === 0 && base ? attributableNonCodeqlChecks(ship.ciFailure, attribution.items) : [];
      if (attributable.length === 0 && failingChecks.length === 0) break;
      if (rounds >= maxRounds) {
        suffix = ` — CI rework budget exhausted after ${rounds} round${rounds === 1 ? '' : 's'}`;
        diagnose = true;
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
          changedFiles: changed,
        });
        const fetched = new Set(logs.jobLogs.map((l) => l.name));
        lastCiFailure = {
          ...(lastCiFailure ?? { failingChecks: [], alerts: [], truncated: false }),
          jobLogs: [...(lastCiFailure?.jobLogs ?? []).filter((l) => !fetched.has(l.name)), ...logs.jobLogs],
        };
      }
      plan = {
        label: 'CI',
        round: rounds,
        reentry: { prNumber: ship.prNumber, previousHeadSha: ship.headSha },
        summary:
          attributable.length > 0
            ? ciReworkSummary(attributable)
            : ciCheckReworkSummary(failingChecks, logs.jobLogs, logs.errors),
        extraInstructions: attributable.length > 0 ? CI_REWORK_INSTRUCTIONS : CI_CHECK_REWORK_INSTRUCTIONS,
      };
    }
    const step = await runCiReworkRound(roundPorts, plan);
    if (step.kind === 'suppressed') return suppressionPark(step.findings);
    if (step.kind === 'ended') return { ship, outcome: step.outcome };
    if (step.kind === 'never-ran') {
      suffix = ` — ${plan.label} rework worker never ran`;
      break;
    }
    ship = step.ship;
  }
  if (ship.ok) return { ship };
  const note = diagnose ? renderCiFailureNote(lastCiFailure) : '';
  const message = ship.denied
    ? `ship denied: ${ship.deniedReason}`
    : ship.reason
      ? `ship phase failed: ${ship.reason}${suffix}`
      : `ship phase failed${suffix}`;
  const full = note && !ship.denied ? `${message}\n${note}` : message;
  return { ship, parked: { reason: shipParkReason(ship), message: full, ciFailure: lastCiFailure ?? ship.ciFailure } };
}
