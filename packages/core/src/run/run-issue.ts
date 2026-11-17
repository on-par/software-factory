import { randomUUID } from 'node:crypto';
import type { Octokit } from '@octokit/rest';

import type { ApprovalGate } from '../approvals/index.js';
import { laneEnv } from '../environment/index.js';
import { buildPhase as buildPhaseDefault } from '../phases/build.js';
import { installLaneDependencies as installLaneDependenciesDefault } from './lane-install.js';
import { checkPhase as checkPhaseDefault, type CheckPhaseResult } from '../phases/check.js';
import type { SizeBudget } from '../readiness/size.js';
import { describeConstitutionSource } from '../constitutions/index.js';
import { lintFactoryConfig } from '../config/config-lint.js';
import {
  codexSandboxWarningMessages,
  sizeGateModeWarningMessages,
  unknownConfigKeyMessages,
} from '../config/config-schema-lint.js';
import { planPhase as planPhaseDefault, type PlanResult } from '../phases/plan.js';
import { planConfigParkMessage } from '../phases/plan-spec-guards.js';
import { shipPhase as shipPhaseDefault } from '../phases/ship.js';
import { codexUnavailable } from '../phases/route-capabilities.js';
import { beginBuildRoute, compatibleBuildModel, laneRouteCapabilities } from './route-sync.js';
import { classifyCheckFailure } from './check-verdict.js';
import { withSingleTerminalEvent } from './terminal-events.js';
import { withRunAttribution, type RunLogFn as LogFn } from './attribution.js';
import { parkPayload, postEnvironmentReleaseComment, publishParkComment } from './park-comment.js';
import { createRunPhaseLogger } from './run-phase-log.js';
import { providerFailureRecorder } from './provider-failure-recorder.js';
import { gateBuildTarget, pickOrderedProvider, type ProviderPick } from './provider-breaker-gate.js';
import {
  buildPickOptions,
  buildTargetForPick,
  planPickOptions,
  providerStageRunner,
  runCheckStage,
  worktreeRestorer,
} from './provider-order-stages.js';
import { loadReusablePlan } from './plan-reuse-load.js';
import { designCheckpointPark } from './design-checkpoint.js';
import {
  allProvidersDownMessage,
  allProvidersDownPayload,
  providerCapGate,
  providersDownOf,
  type StageGateVerdict,
} from './stage-blocked.js';
import { reportFlakeRerun } from './flaky-tests.js';
import { finishWithoutShip } from './local-finish.js';
import { enterStackSlice } from './stack-slice-entry.js';
import type { SlicePlanStore } from '../readiness/slice-plan-store.js';
import { recordShippedSlice } from './slice-ship-record.js';
import type { ReviewFloorPathChange, ReviewFloorRuleSet } from '../review/floor.js';
import {
  classifyPrShadow,
  toClassificationRecord,
  type PrShadowInput,
  type PrShadowVerdict,
} from '../review/classifier.js';
import { shadowErrorVerdict } from './shadow-fallback.js';
import { decideTrustTier, resolveReviewRouting, type ReviewRouting, type TrustTierConfig } from '../review/routing.js';
import { logTrustTier } from './trust-tier-log.js';
import { captureDiffBase } from '../checkers/design-smells.js';
import type { ReworkHistory } from '../checkers/rework-history.js';
import type { AutoFailoverSettings, SizeGateMode } from '../config/index.js';
import { defaultExecFn, type ExecFn } from '../utils/exec.js';
import type { ProviderOrder } from '../config/provider-order.js';
import { decideBuildRoute, type EffectiveModelPins } from '../config/repo.js';
import type { RunStewardPorts } from '../steward/run.js';
import { describeDotnetEnv, dotnetEnvReport } from '../environment/dotnet.js';
import { ProcessGroupTracker } from '../environment/process-groups.js';
import type { AgentEvent } from '../harness/agent-events.js';
import type { ModelRouter } from '../router/index.js';
import type { ProviderBreaker } from '../router/breaker.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { describeSteering, type ConsumedSteering } from '../steering/index.js';
import type { CiFailureEvidence, CheckSummary, Constitution, FailoverReason, FailurePhase } from '../types/index.js';
import { type WorkRequest, type WorkRequestSourceKind, workKeyFromIssue } from '../work/index.js';
import { LOCAL_BRIEF_SOURCE } from '../work/local-brief.js';
import { linearRunWriteback, type LinearRunPorts } from './linear-run.js';
import {
  deferOnLaneCollision,
  releaseLaneClaim,
  touchedFilesFrom,
  type LaneClaimStalenessProbe,
  type LaneFileGuard,
} from './lane-file-guard.js';
import { designSmellFindingFor, parkReasonFor, readyDraftFields, reworkRouteFor } from './outcome.js';
import type { BuildRoute, DesignSmellFinding, ParkReason, RunOutcome } from './outcome.js';
import type { RunPolicy } from './policy.js';
import {
  configParkMessage,
  formatPreservedBuildMessage,
  issueBodyHash,
  preservedFixTarget,
  type CheckResumeStore,
  type PlanReuseStore,
} from './resume-context.js';
import type { Environment, Workspace } from './ports.js';
import { safeRecordRunState, terminalRunStateUpdate, thrownRunStateUpdate } from './run-state-record.js';
import { runStatusForPhase, type RunStateUpdate } from './state.js';
import { type ParkedPrDisposition, settleParkedPullRequest } from './park-pr.js';
import { runParkSteward } from './park-steward.js';
import * as feedbackRound from './feedback-round-hooks.js';
import { reviewReworkResume, runRequestedReviewRework, type ReworkRequestFields } from './review-rework.js';
import { shipWithCiRework, type CiReworkPorts } from './ci-rework-loop.js';
import { parkLogExtra } from './ship-park.js';
import { budgetGuardFor, enforceIssueBudget } from './budget.js';
import type { IssueRunState } from '../types/index.js';
import type { RequiredChecksVerdict } from '../utils/required-checks.js';
import type { RunReportInfo } from './run-report-info.js';
import { providerProbe, type ProviderProbe } from './provider-probe.js';
import type { PrerequisiteStackTarget } from '../queue/prerequisite-stack.js';
import { errorMessage } from '../checkers/preview-wait.js';
import { renderPreviousAttempt } from './previous-attempt.js';
import { withoutHumanOnlyLabels } from './max-lines-override.js';

const SOCKET_PATH_SAFE_RUN_ID_LENGTH = 12;

export interface RunRequest extends ReworkRequestFields {
  previousAttempt?: IssueRunState | null;
  sliceIndex?: number;
  issue: number;
  repo: string;
  branch: string;
  specPath: string;
  work: WorkRequest;
  workSource?: { kind: WorkRequestSourceKind; params: unknown };
  product?: string;
  startedAt: string;
  lane?: string;
  blockedBehind?: number[];
  options: {
    interactive: boolean;
    autoRework: boolean;
    approvePlan: boolean;
    sandboxDisabled: boolean;
  };
  localOnly?: boolean;
  noPr?: boolean;
  blockUnresolvedRegressions?: boolean;
  hermeticGit?: boolean;
  readinessUpdateIssueBody?: boolean;
  publishFromBuild?: boolean;
  sizeGateMode?: SizeGateMode;
  parkOverBudget?: boolean;
  maxSlices?: number;
  sizeBudget?: SizeBudget;
  stewardEnabled?: boolean;
  reviewFloorRules?: ReviewFloorRuleSet;
  prClassifier?: { rules: ReviewFloorRuleSet; gateLabel: string; modelPin?: string } & TrustTierConfig;
  timeouts: { plan: number; build: number; check: number; approval: number; tests: number; compile?: number };
  modelPins: EffectiveModelPins;
  codexDisabled: boolean;
  skipCI: boolean;
  ciDeadlineMs?: number;
  failover: AutoFailoverSettings;
  efficiency: { maxReworkRounds: number; fastPath: boolean };
  sandboxPolicy?: SandboxPolicy;
  codexWorkspacePaths?: { primaryRepoRoot: string; writableRoots: readonly string[] };
  processGroupGraceMs: number;
  providerOrder?: ProviderOrder;
  preferredRoute?: BuildRoute;
  parentBaseRef?: string;
  prerequisiteStack?: PrerequisiteStackTarget;
  resumeFrom?: { phase: 'check'; diffBase?: string; route: BuildRoute; model: string; buildMinutes: number };
  eventsFile?: string;
  logsDir?: string;
  baselineCachePath?: string;
  baselineCacheTtlHours?: number;
  repoConfigFile?: { absPath: string; relPath: string };
  flakyLedgerPath?: string;
  worktreeKeepsPath?: string;
}

export interface RunPorts extends CiReworkPorts, LinearRunPorts {
  slicePlanStore?: SlicePlanStore;
  createSliceBranch?: (opts: { worktree: string; branch: string; startPoint: string }) => Promise<void>;
  steward?: RunStewardPorts;
  router: ModelRouter;
  gitExec?: ExecFn;
  classifyPr?: (input: PrShadowInput) => Promise<PrShadowVerdict>;
  octokit: Octokit;
  workspace: Workspace;
  events: (phase?: string) => LogFn;
  onAgentEvent?: (event: AgentEvent) => void;
  acquireEnvironment?: () => Promise<Environment>;
  resolveBaseUrl?: (appPort: number | undefined) => { baseUrl?: string; note: string };
  getIssueSpend?: () => number;
  breaker: ProviderBreaker;
  probeProvider?: ProviderProbe;
  resolveConstitution: () => Constitution | null;
  createApprovalGate?: () => ApprovalGate;
  drainSteering?: () => ConsumedSteering;
  reworkHistory?: ReworkHistory;
  laneFileGuard?: LaneFileGuard;
  laneClaimStaleness?: LaneClaimStalenessProbe;
  writeLocalRunReport?: (info: RunReportInfo) => Promise<string | undefined>;
  writeBenchmarkArtifacts?: (info: RunReportInfo) => Promise<void>;
  recordPhase?: (phase: FailurePhase) => void | Promise<void>;
  recordRunState?: (update: RunStateUpdate) => void | Promise<void>;
  onActivity?: () => void | Promise<void>;
  planPhase?: typeof planPhaseDefault;
  buildPhase?: typeof buildPhaseDefault;
  installLaneDependencies?: typeof installLaneDependenciesDefault;
  checkPhase?: typeof checkPhaseDefault;
  hostBuildSlot?: <T>(phase: 'build' | 'check', fn: () => Promise<T>) => Promise<T>;
  shipPhase?: typeof shipPhaseDefault;
  requiredChecksVerdict?: (sha: string) => Promise<RequiredChecksVerdict>;
  planReuse?: PlanReuseStore;
  checkResume?: CheckResumeStore;
  readReviewFloorChanges?: (
    worktree: string,
    fallbackBaseRef?: string,
    parentBaseRef?: string,
  ) => Promise<ReviewFloorPathChange[]>;
}

export async function runIssue(request: RunRequest, policy: RunPolicy, rawPorts: RunPorts): Promise<RunOutcome> {
  const { ports: attributed, stamp } = withRunAttribution(rawPorts);
  const ports = withSingleTerminalEvent(attributed);
  const log = ports.events();
  const observed: { checkSummary?: CheckSummary } = {};
  let outcome: RunOutcome;
  try {
    outcome = await runIssueOnce(request, policy, ports, observed);
  } catch (err) {
    const update = thrownRunStateUpdate(request.branch, observed.checkSummary);
    await safeRecordRunState(ports.recordRunState, log, update);
    throw err;
  }
  await safeRecordRunState(ports.recordRunState, log, terminalRunStateUpdate(outcome, observed.checkSummary));
  return stamp(outcome);
}

async function runIssueOnce(
  initialRequest: RunRequest,
  policy: RunPolicy,
  ports: RunPorts,
  observed: { checkSummary?: CheckSummary },
): Promise<RunOutcome> {
  let request = initialRequest;
  const workKey = workKeyFromIssue(request.issue);
  if (request.codexWorkspacePaths) ports.router.setCodexWorkspacePaths?.(request.codexWorkspacePaths);
  ports.router.setAgentEventSink?.((event) => {
    ports.events(event.phase)('agent-event', JSON.stringify(event));
    ports.onAgentEvent?.(event);
  });
  const planPhase = ports.planPhase ?? planPhaseDefault;
  const slot = ports.hostBuildSlot ?? ((_phase, fn) => fn());
  const buildPhase: typeof buildPhaseDefault = (o) => slot('build', () => (ports.buildPhase ?? buildPhaseDefault)(o));
  const checkPhase: typeof checkPhaseDefault = (o) => slot('check', () => (ports.checkPhase ?? checkPhaseDefault)(o));
  const shipPhase = ports.shipPhase ?? shipPhaseDefault;
  const log = ports.events();
  const linear = linearRunWriteback(request.work, ports, log);
  const runId = randomUUID().replace(/-/g, '').slice(0, SOCKET_PATH_SAFE_RUN_ID_LENGTH);
  let previousAttemptNote = renderPreviousAttempt(request.previousAttempt);
  const phaseLogger = createRunPhaseLogger({
    logsDir: request.logsDir,
    issue: workKey,
    runId,
    log: (type, message) => log(type, message),
  });
  const tracker = new ProcessGroupTracker();
  const budgetStop = budgetGuardFor(policy, ports, tracker, request.processGroupGraceMs, log);
  let environment: Environment | undefined;
  let released = false;
  let route: BuildRoute | undefined;
  let reworkRounds: number | undefined;
  let recordedModel: string | undefined;
  let checkSummary: CheckSummary | undefined;
  let failurePhase: FailurePhase = 'plan';
  let runStartDiffBase: string | undefined;
  let laneFileClaimed = false;
  const setPhase = async (phase: FailurePhase): Promise<void> => {
    failurePhase = phase;
    ports.claimSignal?.throwIfAborted();
    try {
      await ports.recordPhase?.(phase);
    } catch (err) {
      log('phase_snapshot_failed', `phase snapshot write failed for '${phase}': ${errorMessage(err)}`);
    }
    await safeRecordRunState(ports.recordRunState, log, {
      status: runStatusForPhase(phase),
      branch: request.branch,
      route,
      model: recordedModel,
      attempts: 1 + (reworkRounds ?? 0),
    });
  };

  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    if (laneFileClaimed) {
      laneFileClaimed = false;
      if (ports.laneFileGuard) await releaseLaneClaim(ports.laneFileGuard, request.repo, workKey, log);
    }
    const outcomes = await tracker.killAll({ graceMs: request.processGroupGraceMs });
    if (outcomes.length > 0) {
      log(
        'environment_cleanup',
        `terminated ${outcomes.length} process group(s)${outcomes.some((o) => o.forced) ? ' (SIGKILL escalation used)' : ''}`,
      );
    }
    if (environment) {
      try {
        await environment.release();
        log('environment_release', `released port ${environment.port} for worktree ${ports.workspace.path}`);
      } catch (err) {
        log('environment_release_failed', `port release failed: ${errorMessage(err)}`);
      }
    }
  };

  const reportOutcomeFor = (reason: ParkReason): 'failed' | 'escalated' =>
    reason === 'escalate' ? 'escalated' : 'failed';

  const writeReports = async (
    reportOutcome: 'failed' | 'escalated',
    reason: ParkReason,
    message: string,
  ): Promise<void> => {
    const reportPath = await ports.writeLocalRunReport?.({
      outcome: reportOutcome,
      route,
      branch: request.branch,
      reworkRounds,
      reason: message,
    });
    await ports.writeBenchmarkArtifacts?.({
      outcome: reportOutcome,
      route,
      branch: request.branch,
      reworkRounds,
      checkSummary,
      failure: { phase: failurePhase, reason, message },
      reportPath,
      diffBase: runStartDiffBase,
    });
  };

  const terminalEscalated = async (message: string): Promise<RunOutcome> => {
    const terminalMessage = phaseLogger.parkMessage(message);
    log('escalate', terminalMessage);
    await writeReports('escalated', 'escalate', terminalMessage);
    return { state: 'escalated', reason: terminalMessage, route, branch: request.branch, reworkRounds };
  };

  let shipStarted = false;
  let runPrNumber: number | undefined;
  let shippedGreen = false;

  const terminalParked = async (
    reason: ParkReason,
    message: string,
    checkFailure?: { failureSignature: string; failingChecks: string[] },
    ciFailure?: CiFailureEvidence,
    down?: StageGateVerdict['down'],
    designSmell?: DesignSmellFinding,
  ): Promise<RunOutcome> => {
    const terminalMessage = phaseLogger.parkMessage(message);
    const failure = reason === 'blocked' ? undefined : checkFailure;
    log(reason, terminalMessage, {
      ...parkLogExtra(failure, ciFailure),
      park: parkPayload(reason, workKey, request.lane, request.blockedBehind ?? [], designSmell),
      ...(down ? { allProvidersDown: allProvidersDownPayload(down, workKey) } : {}),
    });
    if (reason === 'timeout') {
      log('stuck', `run exceeded its phase timeout without progressing — ${terminalMessage}`);
    }
    let settled: ParkedPrDisposition | undefined;
    if (!request.localOnly && !request.noPr) {
      const parkInput = {
        reason,
        message: terminalMessage,
        runId,
        branch: request.branch,
        lane: request.lane,
        blockers: [],
        ...(designSmell ? { designSmell } : {}),
      };
      if (linear) await linear.park(parkInput);
      else if (request.work.kind !== LOCAL_BRIEF_SOURCE) {
        const posted = await publishParkComment({
          octokit: ports.octokit,
          repo: request.repo,
          worktree: ports.workspace.path,
          input: { issue: workKey, ...parkInput },
        });
        if (!posted.ok) log('environment_warning', `could not post the issue park comment: ${posted.error}`);
      }
      if (shipStarted) {
        settled = await settleParkedPullRequest({
          octokit: ports.octokit,
          repo: request.repo,
          issue: workKey,
          branch: request.branch,
          reason,
          prNumber: runPrNumber,
          greenAndChecked: shippedGreen,
          log,
        });
      }
    }
    const outcome: RunOutcome = {
      state: 'parked',
      reason,
      route,
      branch: request.branch,
      reworkRounds,
      ...(settled?.prNumber === undefined ? {} : { prNumber: settled.prNumber }),
      ...failure,
      ...(down ? { providersDown: providersDownOf(down) } : {}),
      ...(designSmell ? { designSmell } : {}),
    };
    await runParkSteward(outcome, request, runId, ports, log);
    await writeReports(reportOutcomeFor(reason), reason, terminalMessage);
    return outcome;
  };

  const parkAllProvidersDown = (down: NonNullable<StageGateVerdict['down']>): Promise<RunOutcome> =>
    terminalParked('all_providers_down', allProvidersDownMessage(down, workKey), undefined, undefined, down);

  const assertBudget = async (phase: string): Promise<RunOutcome | undefined> => {
    const message = enforceIssueBudget({
      phase,
      spend: ports.getIssueSpend?.() ?? 0,
      cap: policy.budget.perIssueCapUsd,
      key: workKey,
      worktreePath: ports.workspace.path,
      keepsFile: request.worktreeKeepsPath,
      log,
      stop: budgetStop.stopped(),
    });
    return message === undefined ? undefined : terminalParked('fail', message);
  };
  const rememberProviderFailureFor = providerFailureRecorder({
    breaker: ports.breaker,
    log,
    issue: workKey,
    defaultCooldownMs: request.failover.cooldownMs,
  });

  const gateDeps = { router: ports.router, breaker: ports.breaker, log, probe: providerProbe(ports) };
  const runStage = providerStageRunner({ ...gateDeps, issue: workKey }, request.providerOrder);
  const gitExec = ports.gitExec ?? defaultExecFn;
  const capGate = providerCapGate(ports.router, ports.breaker, { ...request, issue: workKey }, log, gateDeps.probe);

  try {
    if (ports.acquireEnvironment) {
      try {
        environment = await ports.acquireEnvironment();
      } catch (err) {
        log(
          'environment_lease_failed',
          `port lease unavailable (${errorMessage(err)}) — running without injected PORT`,
        );
      }
    }
    const appPort = environment?.port;
    const onPgid = (pgid: number): void => {
      tracker.track(pgid);
      environment?.recordPgid(pgid);
    };
    const { baseUrl: appBaseUrl, note: proxyNote } = ports.resolveBaseUrl?.(appPort) ?? { note: '' };
    if (proxyNote) log(appBaseUrl ? 'environment_proxy' : 'environment_proxy_unavailable', proxyNote);
    const dotnet = dotnetEnvReport(ports.workspace.path, process.env, runId);
    if (dotnet) log('environment_dotnet', describeDotnetEnv(dotnet));
    const constitution = ports.resolveConstitution();
    log('constitution', describeConstitutionSource(constitution, request.product));
    const lint = lintFactoryConfig({ constitution, configFile: request.repoConfigFile });
    if (lint.verdict !== 'ok') {
      return await terminalParked(
        'config',
        [
          'config preflight failed before PLAN:',
          ...lint.findings.map((f) => f.message),
          `then run factory unpark ${workKey}`,
        ].join('\n'),
      );
    }
    if (request.repoConfigFile) {
      for (const m of unknownConfigKeyMessages(request.repoConfigFile)) log('config_unknown_key', m);
      for (const m of codexSandboxWarningMessages(request.repoConfigFile)) log('config_invalid_value', m);
      for (const m of sizeGateModeWarningMessages(request.repoConfigFile)) log('config_invalid_value', m);
    }

    runStartDiffBase = request.localOnly ? await captureDiffBase(ports.workspace.path) : undefined;
    const planStartedMs = Date.now();
    let planRoute: BuildRoute;
    let planSlice: PlanResult['slice'];
    let buildDiffBase: string | undefined;
    let builtRoute: BuildRoute;
    let builtModel: string;
    let pinNote: string | undefined;
    let buildMinutes: number;
    const feedbackPlan = await feedbackRound.prepareFeedbackForRun(request, ports, log);
    const idle = await feedbackRound.idleFeedbackRound(feedbackPlan, request, ports, route, log);
    if (idle) return idle;
    previousAttemptNote = feedbackRound.feedbackReplanNote(previousAttemptNote, feedbackPlan);
    const resumed = request.resumeFrom ?? reviewReworkResume(request, feedbackPlan);
    if (resumed) {
      ports.events('check')(
        'check',
        `resuming #${workKey} from CHECK on kept branch ${request.branch} — PLAN and BUILD skipped`,
      );
      route = resumed.route;
      planRoute = resumed.route;
      planSlice = undefined;
      buildDiffBase = resumed.diffBase;
      builtRoute = resumed.route;
      builtModel = resumed.model;
      recordedModel = resumed.model;
      pinNote = undefined;
      buildMinutes = resumed.buildMinutes;
    } else {
      await setPhase('plan');
      const decision = decideBuildRoute(ports.router.registryRef, {
        repoRoute: request.preferredRoute,
        buildPin: request.modelPins.build,
        localOnly: request.localOnly,
        codexDisabled: request.codexDisabled,
      });
      if (decision.note && decision.source === 'plan') log('model-override', decision.note);
      const derivedRoute = decision.source === 'build-pin' ? decision.route : undefined;
      const pinnedRoute = request.preferredRoute ?? derivedRoute;
      if (derivedRoute) {
        log(
          'model-override',
          `build route derived from pinned build model ${request.modelPins.build} → ${derivedRoute}`,
        );
      }

      const planReuse = feedbackPlan?.replan ? undefined : ports.planReuse;
      const reused = await loadReusablePlan(planReuse, { ...request, issue: workKey }, log, ports.events('plan'));
      const routeCaps = await laneRouteCapabilities(request, ports, ports.events('plan'));
      const planGate = reused ? undefined : await capGate.enterPlan(route, ports.events('plan'));
      if (planGate?.released) return planGate.released;
      if (planGate?.down) return await parkAllProvidersDown(planGate.down);
      const planAt = (pick: ProviderPick | undefined) =>
        planPhase({
          ...planPickOptions(pick, request.modelPins, ports.router.registryRef, planGate?.skip),
          previousAttempt: previousAttemptNote,
          issue: workKey,
          repo: request.repo,
          worktree: ports.workspace.path,
          specPath: request.specPath,
          constitution,
          router: ports.router,
          sandbox: request.sandboxPolicy,
          octokit: ports.octokit,
          log: ports.events('plan'),
          timeoutSeconds: request.timeouts.plan,
          onProviderFailure: rememberProviderFailureFor('plan'),
          branch: request.branch,
          approvalGate: request.options.approvePlan ? ports.createApprovalGate?.() : undefined,
          drainSteering: request.options.approvePlan ? ports.drainSteering : undefined,
          routeCapabilities: routeCaps,
          localOnly: request.localOnly,
          laneId: request.lane,
          workSource: request.workSource,
          enforceReadiness: true,
          fastPath: request.efficiency.fastPath,
          enforceSizeGate: !request.noPr && request.sizeGateMode !== 'off',
          sizeGateMode: request.sizeGateMode,
          parkOverBudget: request.parkOverBudget,
          sliceIndex: request.sliceIndex,
          slicePlanStore: linear?.slicePlanStore ?? ports.slicePlanStore,
          maxSlices: request.maxSlices,
          sizeBudget: request.sizeBudget,
          blockUnresolvedRegressions: request.blockUnresolvedRegressions,
          updateIssueBodyOnEnrich: request.noPr ? false : request.readinessUpdateIssueBody,
          preferredRoute: pinnedRoute,
          onWorkerResult: phaseLogger.plan,
        });
      const plan = reused ?? (await runStage('plan', planAt));
      route = plan.route;
      if (!plan.ok) {
        if (plan.sliced) {
          return await terminalEscalated(
            `issue #${workKey} sliced into ${plan.sliced.sliceCount} slice(s): ${plan.escalate ?? 'slice plan recorded'}`,
          );
        }
        if (plan.parkReason === 'config') {
          return await terminalParked('config', planConfigParkMessage(plan, workKey));
        }
        return await terminalEscalated(`plan escalated: ${plan.escalate ?? 'unknown'}`);
      }
      const planBudget = await assertBudget('PLAN');
      if (planBudget) return planBudget;
      const designReceipt = await designCheckpointPark(request, ports, plan.route, log);
      if (designReceipt) return await terminalParked('held', designReceipt);

      if (ports.laneFileGuard && plan.designArtifact) {
        const touchedFiles = touchedFilesFrom(plan.designArtifact);
        const staleOpts = ports.laneClaimStaleness && { isStale: ports.laneClaimStaleness, log: ports.events('plan') };
        const collision = await ports.laneFileGuard.findCollision(request.repo, workKey, touchedFiles, staleOpts);
        if (collision) {
          return await deferOnLaneCollision(ports.laneFileGuard, { ...request, issue: workKey }, collision, route, log);
        }
        if (touchedFiles.length > 0) {
          await ports.laneFileGuard.register(request.repo, workKey, touchedFiles);
          laneFileClaimed = true;
        }
      }

      let enteredSlice: PlanResult['slice'];
      if (request.sizeGateMode === 'stack' && plan.slice) {
        const entered = await enterStackSlice({
          slice: plan.slice,
          request,
          ports,
          log,
          park: (message) => terminalParked('fail', message),
        });
        if ('outcome' in entered) return entered.outcome;
        enteredSlice = entered.slice;
        request = entered.request;
      }

      await setPhase('build');
      await (ports.installLaneDependencies ?? installLaneDependenciesDefault)({
        worktree: ports.workspace.path,
        env: laneEnv(appPort, process.env, appBaseUrl, ports.workspace.path, runId),
        sandbox: request.sandboxPolicy,
        localOnly: request.localOnly,
        onPgid,
        log: ports.events('build'),
      }).catch((err: unknown) => {
        ports.events('build')('lane_install_failed', `install threw — continuing to BUILD: ${String(err)}`);
      });
      let buildSteering: ConsumedSteering | undefined;
      if (request.options.interactive) {
        buildSteering = ports.drainSteering?.();
        if (buildSteering && buildSteering.messages.length > 0) {
          ports.events('build')('steering_applied', describeSteering(buildSteering));
        }
      }

      const begun = await beginBuildRoute(request, ports, routeCaps, pinnedRoute ?? plan.route);
      const { buildCaps, syncSpecRoute } = begun;
      let buildRoute = begun.route;
      let buildModel = request.modelPins.build;
      let buildSwapReason: FailoverReason | undefined;
      const orderedBuild = request.providerOrder !== undefined && request.preferredRoute === undefined;
      if (orderedBuild && request.providerOrder) {
        const first = await pickOrderedProvider(gateDeps, request.providerOrder, 'build', new Set());
        if (first)
          ({ route: buildRoute, model: buildModel } = buildTargetForPick(
            first,
            buildModel,
            ports.router.registryRef,
            buildRoute,
          ));
      }
      if (request.failover.enabled && !orderedBuild) {
        const gated = await gateBuildTarget(
          gateDeps,
          { route: buildRoute, model: buildModel },
          {
            routePinned: request.preferredRoute !== undefined,
            codexDisabled: codexUnavailable(buildCaps),
            buildFallback: request.modelPins.buildFallback,
          },
        );
        if (gated.blocked) return await terminalEscalated(`build escalated: ${gated.blocked}`);
        ({ route: buildRoute, model: buildModel, swapReason: buildSwapReason } = gated);
      }
      await syncSpecRoute(buildRoute, 'breaker-gate');
      buildModel = compatibleBuildModel(ports.router.registryRef, buildModel, buildRoute, request.preferredRoute, log);

      const buildGate = await capGate.enterBuild(buildRoute, buildModel, route, buildCaps.codexBreakerOpen);
      if (buildGate.released) return buildGate.released;
      if (buildGate.down) return await parkAllProvidersDown(buildGate.down);
      const fallbackBuildRoute = pinnedRoute ?? plan.route;
      const restoreBuild = orderedBuild
        ? await worktreeRestorer(gitExec, ports.workspace.path, ports.events('build'))
        : undefined;
      const buildAt = (pick: ProviderPick | undefined) =>
        buildPhase({
          ...buildPickOptions(
            pick,
            { route: buildRoute, model: buildModel },
            request.modelPins.build,
            ports.router.registryRef,
            fallbackBuildRoute,
          ),
          ...(orderedBuild ? { crossProviderLadder: false } : {}),
          budgetGuard: budgetStop.guard,
          previousAttempt: previousAttemptNote,
          runId,
          issue: workKey,
          repo: request.repo,
          worktree: ports.workspace.path,
          specPath: request.specPath,
          branch: request.branch,
          constitution,
          router: ports.router,
          log: ports.events('build'),
          timeoutSeconds: request.timeouts.build,
          skipCI: request.skipCI,
          disablePublish: Boolean(request.localOnly || request.noPr),
          publishFromBuild: request.publishFromBuild,
          routePinned: request.preferredRoute !== undefined,
          onWorkerResult: phaseLogger.build,
          codexFallbackModel: request.modelPins.buildFallback ?? ports.router.resolveAll('build_codex')[0],
          onProviderFailure: rememberProviderFailureFor('build'),
          sandbox: request.sandboxPolicy,
          steering: buildSteering,
          appPort,
          appBaseUrl,
          routeCapabilities: buildCaps,
          localOnly: request.localOnly,
          autoFailover: { enabled: request.failover.enabled, fallbackModel: request.failover.fallbackModel },
          onPgid,
          laneId: request.lane,
          parentBaseRef: request.parentBaseRef,
          openQuestions: plan.designArtifact?.openQuestions,
        });
      const build = await (orderedBuild
        ? runStage('build', buildAt, { beforeRerun: restoreBuild })
        : buildAt(undefined));
      route = build.route;
      await syncSpecRoute(build.route, 'build-failover');
      if (!build.ok && build.reason !== 'budget_exceeded') {
        if (build.sandboxEnv) return await terminalParked('sandbox-env', build.sandboxEnv);
        const why = build.noDiffDetail ? `\n\n${build.noDiffDetail}` : '';
        const parkText =
          build.reason === 'no_diff'
            ? 'build produced no diff against the base ref'
            : build.reason === 'junk_only_diff'
              ? 'build changed only generated/cache files (e.g. __pycache__)'
              : undefined;
        if (parkText) return await terminalParked('fail', `${parkText} — no implementation was produced${why}`);
        return await terminalEscalated(`build escalated: ${build.escalate ?? 'unknown'}`);
      }
      const buildBudget = await assertBudget('BUILD');
      if (buildBudget) return buildBudget;
      const pinnedBuild = request.modelPins.build;
      pinNote =
        pinnedBuild !== undefined && build.model !== pinnedBuild
          ? `build pin ${pinnedBuild} not used (${build.failoverReason ?? buildSwapReason ?? 'overridden'}); built with ${build.model}`
          : undefined;

      planRoute = plan.route;
      planSlice = enteredSlice ?? plan.slice;
      buildDiffBase = build.diffBase;
      builtRoute = build.route;
      builtModel = build.model;
      recordedModel = build.model;
      buildMinutes = Math.max(1, Math.round((Date.now() - planStartedMs) / 60_000));
    }

    await setPhase('check');
    const priorFailureSignature = await ports.reworkHistory?.priorSignature(request.issue);
    const checkOpts = {
      budgetGuard: budgetStop.guard,
      runId,
      hermeticGit: request.hermeticGit,
      issue: workKey,
      worktree: ports.workspace.path,
      specPath: request.specPath,
      constitution,
      router: ports.router,
      log: ports.events('check'),
      autoRework: request.options.autoRework,
      maxReworkRounds: request.efficiency.maxReworkRounds,
      buildTimeoutSeconds: request.timeouts.build,
      checkTimeoutSeconds: request.timeouts.check,
      testsTimeoutSeconds: request.timeouts.tests,
      compileTimeoutSeconds: request.timeouts.compile,
      sandbox: request.sandboxPolicy,
      drainSteering: request.options.interactive ? ports.drainSteering : undefined,
      appPort,
      appBaseUrl,
      onPgid,
      processGroupTracker: tracker,
      priorFailureSignature,
      diffBase: request.localOnly ? runStartDiffBase : buildDiffBase,
      parentBaseRef: request.parentBaseRef,
      reviewFloorRules: request.reviewFloorRules,
      ...reworkRouteFor(builtRoute, builtModel),
      laneId: request.lane,
      onActivity: ports.onActivity,
      logsDir: request.logsDir,
      onWorkerResult: phaseLogger.rework,
      baselineCachePath: request.baselineCachePath,
      baselineCacheTtlHours: request.baselineCacheTtlHours,
      requiredChecksVerdict: ports.requiredChecksVerdict,
    };
    capGate.watchCheck(builtRoute, builtModel);
    await runRequestedReviewRework(request, ports, checkOpts, feedbackPlan);
    const check = await (request.providerOrder
      ? runCheckStage(
          runStage,
          { ...gateDeps, order: request.providerOrder },
          checkPhase,
          checkOpts,
          await worktreeRestorer(gitExec, ports.workspace.path, ports.events('check')),
        )
      : checkPhase(checkOpts));
    checkSummary = check.summary;
    observed.checkSummary = check.summary;
    reworkRounds = check.reworkRounds;
    await reportFlakeRerun(check, request, ports.octokit, log);
    const clearCheckResume = async (): Promise<void> => {
      if (!request.resumeFrom) return;
      try {
        await ports.checkResume?.clear();
      } catch (err) {
        log('environment_warning', `could not clear the check-resume point: ${errorMessage(err)}`);
      }
    };
    const finishFailedCheck = async (
      failed: CheckPhaseResult,
      opts: { ciReworkRound?: number } = {},
    ): Promise<RunOutcome> => {
      if (failed.sandboxEnv) return terminalParked('sandbox-env', failed.sandboxEnv);
      if (failed.infra) return terminalParked('check-infra', failed.infra);
      if (failed.environment) {
        const env = failed.environment;
        if (env.cause === 'config') {
          await clearCheckResume();
          const failure =
            failed.failureSignature !== undefined
              ? { failureSignature: failed.failureSignature, failingChecks: env.failingChecks }
              : undefined;
          return terminalParked(
            'config',
            configParkMessage({
              issue: workKey,
              failure: env,
              summary: failed.summary,
              constitution,
              configFile: request.repoConfigFile,
            }),
            failure,
          );
        }
        if (linear && !request.localOnly && !request.noPr) await linear.environment(env);
        else if (!request.localOnly && !request.noPr) {
          const warn = (message: string) => log('environment_warning', message);
          await postEnvironmentReleaseComment({
            octokit: ports.octokit,
            repo: request.repo,
            issue: workKey,
            env,
            warn,
          });
        }
        let preserve =
          ports.checkResume !== undefined &&
          !request.localOnly &&
          !request.noPr &&
          !planSlice &&
          opts.ciReworkRound === undefined;
        let fixTarget = '';
        if (preserve && ports.checkResume) {
          fixTarget = preservedFixTarget(env, constitution, request.repoConfigFile);
          try {
            await ports.checkResume.record({
              issue: workKey,
              branch: request.branch,
              worktree: ports.workspace.path,
              diffBase: buildDiffBase,
              baseSha: env.baseSha,
              route: builtRoute,
              model: builtModel,
              buildMinutes,
              fixTarget,
              preservedAt: new Date().toISOString(),
            });
          } catch (err) {
            log('environment_warning', `could not record the check-resume point: ${errorMessage(err)}`);
            preserve = false;
          }
        }
        log(
          'environment-released',
          `every failing checker (${env.failingChecks.join(', ')}) also fails on base ${env.baseSha.slice(0, 8)} — no rework, releasing #${workKey} to queued` +
            (preserve
              ? ` — ${formatPreservedBuildMessage({ issue: workKey, branch: request.branch, buildMinutes, fixTarget })}`
              : ''),
        );
        if (ports.planReuse && !planSlice && !request.resumeFrom) {
          try {
            await ports.planReuse.record({
              bodyHash: issueBodyHash(request.work.brief),
              baseSha: env.baseSha,
              route: planRoute,
              releasedAt: new Date().toISOString(),
            });
          } catch (err) {
            log('environment_warning', `could not record the plan-reuse record: ${errorMessage(err)}`);
          }
        }
        return {
          state: 'released',
          reason: 'environment',
          route,
          branch: request.branch,
          reworkRounds: 0,
          baseSha: env.baseSha,
          failingChecks: env.failingChecks,
          ...(failed.failureSignature !== undefined ? { failureSignature: failed.failureSignature } : {}),
          ...(preserve ? { buildPreserved: true } : {}),
          ...(env.confirmedLocally ? { confirmedLocally: true } : {}),
        };
      }
      const verdict = classifyCheckFailure(failed, opts);
      if (verdict.checkFailure) {
        await ports.reworkHistory?.record(
          request.issue,
          verdict.checkFailure.failureSignature,
          verdict.checkFailure.failingChecks,
        );
      }
      await clearCheckResume();
      return terminalParked(verdict.reason, verdict.message, verdict.checkFailure);
    };
    const onRecheck = async (recheck: CheckPhaseResult, round: number): Promise<RunOutcome | undefined> => {
      observed.checkSummary = recheck.summary;
      const recheckBudget = await assertBudget('CHECK');
      if (recheckBudget) return recheckBudget;
      return recheck.passed ? undefined : finishFailedCheck(recheck, { ciReworkRound: round });
    };
    const checkBudget = await assertBudget('CHECK');
    if (checkBudget) return checkBudget;
    if (!check.passed) return await finishFailedCheck(check);
    await clearCheckResume();
    await ports.reworkHistory?.clear(request.issue);

    const unshipped = await finishWithoutShip(request, ports, log, {
      route,
      reworkRounds,
      checkSummary,
      diffBase: runStartDiffBase,
    });
    if (unshipped) return unshipped;

    let reviewRouting: ReviewRouting | undefined;
    if (request.prClassifier) {
      reviewRouting = await resolveReviewRouting({
        worktree: ports.workspace.path,
        fallbackBaseRef: buildDiffBase,
        parentBaseRef: request.parentBaseRef,
        rules: request.prClassifier.rules,
        readChanges: ports.readReviewFloorChanges,
      });
      reviewRouting = decideTrustTier(reviewRouting, request.prClassifier, request);
      logTrustTier(reviewRouting, 'demotion', log);
      if (reviewRouting.gated) {
        const label = request.prClassifier.gateLabel;
        const [owner, repoName] = request.repo.split('/');
        const labels = withoutHumanOnlyLabels([label]);
        try {
          if (labels.length > 0)
            await ports.octokit.rest.issues.addLabels({ owner, repo: repoName, issue_number: request.issue, labels });
        } catch (err) {
          return await terminalParked(
            'held',
            `issue held: classifier gate label '${label}' could not be applied (${reviewRouting.reason}): ${errorMessage(err)} — needs a human`,
          );
        }
        log(
          'merge-gated',
          `${reviewRouting.reason} — applied ${label}; auto-merge held for a human${reviewRouting.error ? ` (${reviewRouting.error})` : ''}`,
        );
      }
      logTrustTier(reviewRouting, 'receipt', log);

      const shadowInput: PrShadowInput = {
        worktree: ports.workspace.path,
        fallbackBaseRef: buildDiffBase,
        issueTitle: request.work.title,
        issueBody: request.work.brief,
        specPath: request.specPath,
        floor: reviewRouting.floor,
        floorRules: reviewRouting.rules,
        rules: request.prClassifier.rules,
        modelPin: request.prClassifier.modelPin,
        router: ports.router,
        sandbox: request.sandboxPolicy,
        onLog: (msg: string) => log('router', msg),
      };
      let shadow: PrShadowVerdict;
      try {
        shadow = await (ports.classifyPr ?? classifyPrShadow)(shadowInput);
      } catch (err) {
        shadow = shadowErrorVerdict(reviewRouting.floor, request.prClassifier.rules, errorMessage(err));
      }
      reviewRouting = { ...reviewRouting, shadow };
      log(
        'pr-classified',
        `shadow — no effect: model ${shadow.modelClass ?? 'null'}${shadow.reason ? ` (${shadow.reason})` : ''}, floor ${shadow.floorClass ?? 'error'}, final ${shadow.finalClass ?? 'error'}`,
        { model: shadow.model ?? undefined, prClassification: toClassificationRecord(shadow) },
      );
    }

    await setPhase('ship');
    shipStarted = true;
    const shipped = await shipWithCiRework(
      {
        request,
        ports,
        shipPhase,
        checkPhase,
        checkOpts,
        check,
        constitution,
        appPort,
        appBaseUrl,
        onPgid,
        runId,
        onRecheck,
      },
      { builtRoute, builtModel, reviewRouting, pinNote, planSlice, pr: policy.pr },
    );
    runPrNumber = shipped.ship.prNumber;
    shippedGreen = shipped.ship.ok && !shipped.ship.alreadyDelivered && shipped.ship.ciOutcome === 'success';
    if (shipped.outcome) return shipped.outcome;
    const { ship, parked } = shipped;
    if (parked) return await terminalParked(parked.reason, parked.message, parked.checkFailure, parked.ciFailure);
    await feedbackRound.publishFeedbackForRun(request, ports, feedbackPlan, ship.headSha, log);

    if (planSlice) {
      const failure = await recordShippedSlice({
        octokit: ports.octokit,
        repo: request.repo,
        key: workKey,
        branch: request.branch,
        plan: planSlice.plan,
        index: planSlice.index,
        ship,
        worktree: ports.workspace.path,
        readHeadSha: ports.readWorktreeHead,
        stackMode: request.work.kind !== LOCAL_BRIEF_SOURCE,
        store: linear?.slicePlanStore ?? ports.slicePlanStore,
        log,
      });
      if (failure !== undefined) return await terminalParked('fail', failure);
    }

    if (request.skipCI) {
      log('skip-ci', `skipping CI watch (FACTORY_SKIP_CI=1) — merging on local verify`);
    }
    const readyMsg = ship.alreadyDelivered
      ? `already delivered${ship.prNumber !== undefined ? ` by merged PR #${ship.prNumber}` : ' — branch already landed on main'}`
      : `PR #${ship.prNumber} ${ship.draft ? 'left as draft' : 'ready for review'}${ship.ciPending ? ' (CI pending)' : ''}`;
    log('ready', pinNote ? `${readyMsg} (${pinNote})` : readyMsg);
    await ports.writeLocalRunReport?.({ outcome: 'ready', route, branch: request.branch, reworkRounds });
    return {
      state: 'ready',
      route,
      branch: request.branch,
      reworkRounds,
      prNumber: ship.prNumber,
      ...readyDraftFields(ship),
      ...(planSlice ? { slice: { index: planSlice.index, count: planSlice.plan.slices.length } } : {}),
    };
  } catch (err) {
    if (ports.claimSignal?.aborted) throw err;
    if ((err as { reason?: unknown } | null | undefined)?.reason === 'local_auth') {
      log(
        'environment_warning',
        'provider CLI authentication failed in this launch context (local_auth) — an ops/environment failure, ' +
          'not a failure of the issue itself; on macOS a launch context without login-keychain access (e.g. tmux) ' +
          'cannot refresh Claude OAuth — run `factory doctor` (#1014)',
      );
    }
    const capped = await capGate.afterFailure(err, failurePhase, route);
    if (capped?.released) return capped.released;
    if (capped?.down) return await parkAllProvidersDown(capped.down);
    return await terminalParked(
      parkReasonFor(err),
      errorMessage(err),
      undefined,
      undefined,
      undefined,
      designSmellFindingFor(err),
    );
  } finally {
    await release();
  }
}
