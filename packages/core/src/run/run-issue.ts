// packages/core/src/run/run-issue.ts — the per-issue run lifecycle, lifted out of the
// CLI's shipIssue (#675). runIssue(request, policy, ports) sequences PLAN → BUILD →
// CHECK → SHIP and enforces five invariants at this seam:
//   1. the constitution is resolved exactly once, before BUILD, and reused by every phase.
//   2. the per-issue budget is asserted after PLAN, BUILD, and CHECK (parks 'fail' on breach).
//   3. the acquired Environment is released exactly once on every exit path.
//   4. a failed environment lease degrades (appPort undefined) rather than parking the run.
//   5. exactly one terminal event sequence is emitted per run, matching the returned RunOutcome
//      (including the non-park `released` exit for an environment-caused CHECK failure, #1928; a config cause parks, #2583;
//      phase-scoped loggers cannot emit a terminal kind: withSingleTerminalEvent demotes them, #3435).
// PLAN may be skipped by the planReuse port after an environment release (#2340).
// CHECK may be resumed on a kept worktree via request.resumeFrom after an environment release (#2564).
// Every park posts or edits one issue-level park comment behind a hidden marker; a GitHub failure only logs a warning (#2314).
// A config preflight (#2586) rejects unfilled template tokens before base health and PLAN; any preflight failure parks with the `config` cause (#2587).
//
// Path-bound CLI concerns (Octokit, worktree/environment provisioning, the events sink,
// approval/steering, and reporting hooks) are injected as ports so this file stays free of
// CLI filesystem layout (ADR-0004). The CLI's shipIssue is a thin adapter that constructs
// these ports and re-raises a parked/escalated outcome as LaneParkError.

import { randomUUID } from 'node:crypto';
import type { Octokit } from '@octokit/rest';

import type { ApprovalGate } from '../approvals/index.js';
import type { checkBaseHealth } from '../checkers/base-health.js';
import { laneEnv } from '../environment/index.js';
import { buildPhase as buildPhaseDefault } from '../phases/build.js';
import { installLaneDependencies as installLaneDependenciesDefault } from './lane-install.js';
import {
  checkPhase as checkPhaseDefault,
  type CheckPhaseResult,
  renderEnvironmentReleaseComment,
} from '../phases/check.js';
import type { SizeBudget } from '../readiness/size.js';
import { describeConstitutionSource } from '../constitutions/index.js';
import { lintFactoryConfig } from '../config/config-lint.js';
import { planPhase as planPhaseDefault, type PlanResult } from '../phases/plan.js';
import { planConfigParkMessage } from '../phases/plan-spec-guards.js';
import { shipPhase as shipPhaseDefault } from '../phases/ship.js';
import { classifyCheckFailure } from './check-verdict.js';
import { withSingleTerminalEvent } from './terminal-events.js';
import { withRunAttribution, type RunLogFn as LogFn } from './attribution.js';
import { environmentReleaseMarker, publishParkComment, upsertMarkerComment } from './park-comment.js';
import { createRunPhaseLogger } from './run-phase-log.js';
import { gateOpencodeBuildOnBreaker, providerFallbackPreferrer } from './provider-breaker-gate.js';
import { fileFlakyTests } from './flaky-tests.js';
import { finishWithoutShip } from './local-finish.js';
import { enterStackSlice, stackWaitOutcome } from './stack-slice-entry.js';
import { recordShippedSlice } from './slice-ship-record.js';
import type { ReviewFloorPathChange, ReviewFloorRuleSet } from '../review/floor.js';
import {
  CLASSIFIER_PROMPT_VERSION,
  classifierPolicyVersion,
  classifyPrShadow,
  toClassificationRecord,
  type PrShadowInput,
  type PrShadowVerdict,
} from '../review/classifier.js';
import { resolveReviewRouting, type ReviewRouting } from '../review/routing.js';
import { captureDiffBase } from '../checkers/design-smells.js';
import type { ReworkHistory } from '../checkers/rework-history.js';
import type { AutoFailoverSettings, SizeGateMode } from '../config/index.js';
import { decideBuildRoute, type EffectiveModelPins, routeForBuildModel } from '../config/repo.js';
import { detectStuck } from '../steward/detect.js';
import { runSteward, type RunStewardPorts } from '../steward/run.js';
import { describeDotnetEnv, dotnetEnvReport } from '../environment/dotnet.js';
import { ProcessGroupTracker } from '../environment/process-groups.js';
import type { ModelRouter, ProviderFailureInfo } from '../router/index.js';
import { gateBuildOnBreaker, reportedCooldownMs, type ProviderBreaker } from '../router/breaker.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { describeSteering, type ConsumedSteering } from '../steering/index.js';
import type { CiFailureEvidence, CheckSummary, Constitution, FailoverReason, FailurePhase } from '../types/index.js';
import type { WorkRequest, WorkRequestSourceKind } from '../work/index.js';
import {
  releaseLaneClaim,
  touchedFilesFrom,
  type LaneClaimStalenessProbe,
  type LaneFileGuard,
} from './lane-file-guard.js';
import { parkReasonFor, reworkRouteFor, type BuildRoute, type ParkReason, type RunOutcome } from './outcome.js';
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
import { isDecomposeSignal } from './run-state-record.js';
import { runStatusForPhase, type RunStateUpdate } from './state.js';
import { shipWithCiRework, type CiReworkPorts } from './ci-rework-loop.js';
import { parkLogExtra } from './ship-park.js';
import { budgetGuardFor, enforceIssueBudget } from './budget.js';
import type { IssueRunState } from '../types/index.js';
import { renderPreviousAttempt } from './previous-attempt.js';
import { withoutHumanOnlyLabels } from './max-lines-override.js';

/** Everything one run needs decided, as a plain resolved value — the CLI adapter
 *  computes this today; no config/file/path resolution happens in here. */
export interface RunRequest {
  /** Prior run's persisted record, read before this run's first write (#3373); null/absent = none. */
  previousAttempt?: IssueRunState | null;
  /** ADR-0161 stack mode: the 1-based slice to plan. Set by runIssue's stack loop; undefined = the gate's current slice. */
  sliceIndex?: number;
  issue: number;
  repo: string;
  branch: string;
  specPath: string;
  work: WorkRequest;
  /** Input source for PLAN to resolve; defaults inside planPhase to this run's GitHub issue. */
  workSource?: { kind: WorkRequestSourceKind; params: unknown };
  product?: string;
  startedAt: string;
  lane?: string;
  options: {
    interactive: boolean;
    autoRework: boolean;
    /** Pause after PLAN for a human decision. */
    approvePlan: boolean;
    sandboxDisabled: boolean;
  };
  /** Local-only run (#508): publishing disabled, SHIP is skipped. */
  localOnly?: boolean;
  /** --no-pr: stop after a clean CHECK with no GitHub writes; unlike localOnly, routing and prompts are unchanged. */
  noPr?: boolean;
  /** PR classifier gate (#1724). Present only when the setting is on; undefined = off (no git
   *  calls, no label, no event, no evidence-pack section). */
  /** design.blockUnresolvedRegressions resolved (#1819); undefined = off. */
  blockUnresolvedRegressions?: boolean;
  /** check.hermeticGit resolved (#3272); undefined = on. */
  hermeticGit?: boolean;
  /** readiness.updateIssueBody resolved (#2385); undefined = on. */
  readinessUpdateIssueBody?: boolean;
  /** build.publishFromBuild resolved (#1867); undefined = off (commit-only BUILD on every route). */
  publishFromBuild?: boolean;
  /** sizeGate.mode resolved (ADR-0147, #2048); undefined = file (both size gates on). */
  sizeGateMode?: SizeGateMode;
  /** sizeGate.maxSlices or --max-slices resolved (ADR-0156); undefined = DEFAULT_MAX_SLICES. */
  maxSlices?: number;
  /** sizeGate.tokenBudget / maxFiles resolved (#3350); undefined = defaults. */
  sizeBudget?: SizeBudget;
  /** steward.enabled resolved (#2086); undefined = off (no steward-triggered event). */
  stewardEnabled?: boolean;
  prClassifier?: { rules: ReviewFloorRuleSet; gateLabel: string; modelPin?: string };
  timeouts: { plan: number; build: number; check: number; approval: number; tests: number; compile?: number };
  modelPins: EffectiveModelPins;
  codexDisabled: boolean;
  skipCI: boolean;
  failover: AutoFailoverSettings;
  efficiency: { maxReworkRounds: number; fastPath: boolean };
  /** Sandbox containment already resolved against this run's worktree/repoRoot. */
  sandboxPolicy?: SandboxPolicy;
  /** Resolved primary checkout paths for Codex workspace-write. */
  codexWorkspacePaths?: { primaryRepoRoot: string; writableRoots: readonly string[] };
  /** Grace period before escalating to SIGKILL when tearing down tracked process groups. */
  processGroupGraceMs: number;
  /** Repo config pins the build route; forced after PLAN so the frozen spec stays authoritative. */
  preferredRoute?: BuildRoute;
  /** Resume at CHECK on a kept worktree (#2564): PLAN and BUILD are skipped. */
  /** Parent ref of a stacked slice branch (#2716); CHECK and the review floor diff against it. Absent = origin/main. */
  parentBaseRef?: string;
  resumeFrom?: { phase: 'check'; diffBase?: string; route: BuildRoute; model: string; buildMinutes: number };
  /** Resolved factory-state paths shipPhase reads/writes directly (unchanged from today —
   *  shipPhase's own surface already takes plain path strings, not a path-resolution port). */
  eventsFile?: string;
  logsDir?: string;
  /** state/baseline-cache.json (#1926), forwarded to checkPhase. */
  baselineCachePath?: string;
  /** The repo config file (`.factory/config.yaml|yml|json`) to scan in the pre-PLAN template-token preflight (#2586); undefined = constitution only. */
  repoConfigFile?: { absPath: string; relPath: string };
  /** state/flaky-tests.json (#2303); undefined = no flake ledger or filing. */
  flakyLedgerPath?: string;
  /** state/worktree-keeps.json (#3316); undefined = a budget park records no keep. */
  worktreeKeepsPath?: string;
}

interface RunReportInfo {
  outcome: 'ready' | 'failed' | 'parked' | 'escalated';
  route?: BuildRoute;
  branch?: string;
  reworkRounds?: number;
  checkSummary?: CheckSummary;
  reason?: string;
  failure?: { phase: FailurePhase; reason: string; message: string };
  reportPath?: string;
  diffBase?: string;
}

/** The injected seams runIssue needs. Effectful, path-bound concerns (Octokit, worktree
 *  layout, approvals/steering directories, report/artifact destinations) are the caller's
 *  responsibility to wire — runIssue only calls the closures it is handed. */
export interface RunPorts extends CiReworkPorts {
  /** ADR-0161 stack mode: creates a slice branch in the worktree. Defaults to createStackSliceBranch. */
  createSliceBranch?: (opts: { worktree: string; branch: string; startPoint: string }) => Promise<void>;
  /** Stuck-run steward seams (#2124). Used only when request.stewardEnabled is true and detectStuck fires
   *  on the park; absent → only the steward-triggered event is logged (#2086). */
  steward?: RunStewardPorts;
  router: ModelRouter;
  /** Shadow classifier model call (#1725). Defaults to classifyPrShadow. */
  classifyPr?: (input: PrShadowInput) => Promise<PrShadowVerdict>;
  octokit: Octokit;
  /** The working tree the phases run in (`.path` is the phase cwd). */
  workspace: Workspace;
  /** `mkLog` factory: `events(phase)` returns the log function phases/runIssue emit through. */
  events: (phase?: string) => LogFn;
  /** Acquires the lane's leased port + process-group tracking. A rejection here degrades
   *  the run (appPort left undefined) rather than parking it (Invariant 4). */
  acquireEnvironment?: () => Promise<Environment>;
  /** Resolves the stable lane base URL for the (possibly undefined) leased port. Injected
   *  because the underlying proxy-state probe needs CLI-owned factory state paths. */
  resolveBaseUrl?: (appPort: number | undefined) => { baseUrl?: string; note: string };
  /** Current accumulated spend for this issue (the router's cost sink is wired by the
   *  caller before it hands `router` to runIssue); absent means no budget cap in effect. */
  getIssueSpend?: () => number;
  breaker: ProviderBreaker;
  /** Resolves the constitution. Called exactly once, before BUILD (Invariant 1). */
  resolveConstitution: () => Constitution | null;
  createApprovalGate?: () => ApprovalGate;
  drainSteering?: () => ConsumedSteering;
  reworkHistory?: ReworkHistory;
  /** Same-file lane guard (#1515): parks a run whose PLAN-reported touched files collide
   *  with another in-flight run's claim in the same repo. Optional and a no-op when
   *  undefined, so existing callers/tests that don't wire it see no behavior change.
   *  `laneClaimStaleness` (#3063) lets it reap provably finished holders; undefined = never reap. */
  laneFileGuard?: LaneFileGuard;
  laneClaimStaleness?: LaneClaimStalenessProbe;
  /** PLAN's pre-flight size gate decomposed this issue into filed sub-issues. The hook
   *  owns the (path-bound) queue rewrite and is expected to throw to signal the caller;
   *  if it returns normally, runIssue treats the decomposition as an escalation. */
  onDecomposed?: (childIssues: number[]) => void | Promise<void>;
  writeLocalRunReport?: (info: RunReportInfo) => Promise<string | undefined>;
  writeBenchmarkArtifacts?: (info: RunReportInfo) => Promise<void>;
  /** Records the truthful current phase for downstream connectors (#1325) — called once
   *  at each of the four PLAN/BUILD/CHECK/SHIP transitions. A rejection here is logged
   *  and swallowed: this is an observability side channel, not a run invariant. */
  recordPhase?: (phase: FailurePhase) => void | Promise<void>;
  /** Persists the IssueRunState (#3194) — called at the four phase transitions and once
   *  with the terminal status. A rejection is logged as `run_state_failed` and swallowed:
   *  an observability side channel, not a run invariant. */
  recordRunState?: (update: RunStateUpdate) => void | Promise<void>;
  /** Heartbeat hook (#1326) forwarded to CHECK's CheckerContext — called around every
   *  checker so the persisted run-phase snapshot's `lastActivityAt` advances during a
   *  long CHECK stage, not just at the four phase transitions `recordPhase` covers. A
   *  rejection is logged and swallowed the same way (observability, not an invariant). */
  onActivity?: () => void | Promise<void>;
  /** Phase implementations. Default to the real PLAN/BUILD/CHECK/SHIP phases; overridable
   *  so callers (notably the CLI's test double, per ADR-0004) can stub the phases and drive
   *  the real runIssue sequencing/breaker/budget/constitution logic instead of reimplementing it. */
  planPhase?: typeof planPhaseDefault;
  buildPhase?: typeof buildPhaseDefault;
  /** Frozen JS dependency install in the lane worktree before BUILD (#3370). Defaults to installLaneDependencies; never throws. */
  installLaneDependencies?: typeof installLaneDependenciesDefault;
  checkPhase?: typeof checkPhaseDefault;
  hostBuildSlot?: <T>(phase: 'build' | 'check', fn: () => Promise<T>) => Promise<T>;
  shipPhase?: typeof shipPhaseDefault;
  /** Pre-PLAN health check of origin/main (#2339). Absent = skipped (existing callers/tests unchanged). */
  checkBaseHealth?: typeof checkBaseHealth;
  /** Frozen-plan reuse after an environment release (#2340). Absent = always plan (existing callers/tests unchanged). */
  planReuse?: PlanReuseStore;
  /** Check-resume record (#2564). Absent = no preservation (existing callers/tests unchanged). */
  checkResume?: CheckResumeStore;
  /** Reads the PR's path changes for the classifier (#1724). Defaults to the git-backed reader. */
  readReviewFloorChanges?: (
    worktree: string,
    fallbackBaseRef?: string,
    parentBaseRef?: string,
  ) => Promise<ReviewFloorPathChange[]>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
    const update = thrownRunStateUpdate(isDecomposeSignal(err), request.branch, observed.checkSummary);
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
  if (request.codexWorkspacePaths) ports.router.setCodexWorkspacePaths?.(request.codexWorkspacePaths);
  const planPhase = ports.planPhase ?? planPhaseDefault;
  const slot = ports.hostBuildSlot ?? ((_phase, fn) => fn());
  const buildPhase: typeof buildPhaseDefault = (o) => slot('build', () => (ports.buildPhase ?? buildPhaseDefault)(o));
  const checkPhase: typeof checkPhaseDefault = (o) => slot('check', () => (ports.checkPhase ?? checkPhaseDefault)(o));
  const shipPhase = ports.shipPhase ?? shipPhaseDefault;
  const log = ports.events();
  // One id per run: BUILD, CHECK and rework share a per-run VBCSCompiler server (#1910).
  // 12 hex chars keeps the compiler's Unix-socket pipe path short under macOS $TMPDIR.
  const runId = randomUUID().replace(/-/g, '').slice(0, 12);
  const previousAttemptNote = renderPreviousAttempt(request.previousAttempt);
  const phaseLogger = createRunPhaseLogger({
    logsDir: request.logsDir,
    issue: request.issue,
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
      if (ports.laneFileGuard) await releaseLaneClaim(ports.laneFileGuard, request.repo, request.issue, log);
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

  // Every escalated/parked exit reports the same way a thrown park did before the lift:
  // one terminal event (plus a 'stuck' companion for timeouts) and, when hooks are wired,
  // a local run report + benchmark artifacts (Invariant 5).
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

  const terminalParked = async (
    reason: ParkReason,
    message: string,
    checkFailure?: { failureSignature: string; failingChecks: string[] },
    ciFailure?: CiFailureEvidence,
  ): Promise<RunOutcome> => {
    const terminalMessage = phaseLogger.parkMessage(message);
    // A blocked park never carries a failure signature, so the ADR-0139 lane breaker and the cross-run stuck check skip it (#2315).
    const failure = reason === 'blocked' ? undefined : checkFailure;
    log(reason, terminalMessage, parkLogExtra(failure, ciFailure));
    if (reason === 'timeout') {
      log('stuck', `run exceeded its phase timeout without progressing — ${terminalMessage}`);
    }
    if (!request.localOnly && !request.noPr) {
      const posted = await publishParkComment({
        octokit: ports.octokit,
        repo: request.repo,
        worktree: ports.workspace.path,
        input: {
          issue: request.issue,
          reason,
          message: terminalMessage,
          runId,
          branch: request.branch,
          lane: request.lane,
          blockers: [],
        },
      });
      if (!posted.ok) log('environment_warning', `could not post the issue park comment: ${posted.error}`);
    }
    const outcome: RunOutcome = {
      state: 'parked',
      reason,
      route,
      branch: request.branch,
      reworkRounds,
      ...failure,
    };
    // The steward runs after the park event and before the reports and the return, so it finishes
    // before the CLI raises LaneParkError or pauses the lane (#2124).
    if (request.stewardEnabled === true) {
      const stuck = detectStuck(outcome);
      if (stuck) {
        log(
          'steward-triggered',
          `stuck run picked up for the steward: ${stuck.trigger}${stuck.failureSignature ? ` (signature ${stuck.failureSignature})` : ''}`,
          { stewardTriggered: stuck },
        );
        if (ports.steward) {
          await runSteward(
            {
              runId,
              repo: request.repo,
              issue: { number: request.issue, title: request.work.title, body: request.work.brief },
              stuck,
              planPath: request.specPath,
            },
            ports.steward,
          );
        }
      }
    }
    await writeReports(reportOutcomeFor(reason), reason, terminalMessage);
    return outcome;
  };

  const assertBudget = async (phase: string): Promise<RunOutcome | undefined> => {
    // prettier-ignore
    const message = enforceIssueBudget({ phase, spend: ports.getIssueSpend?.() ?? 0, cap: policy.budget.perIssueCapUsd, issue: request.issue, worktreePath: ports.workspace.path, keepsFile: request.worktreeKeepsPath, log, stop: budgetStop.stopped() });
    return message === undefined ? undefined : terminalParked('fail', message);
  };

  const rememberProviderFailure = async ({
    provider,
    reason,
    kind,
    resetAt,
    detail,
  }: ProviderFailureInfo): Promise<void> => {
    const reportedMs = reportedCooldownMs(resetAt, detail);
    const cooldownMs = reportedMs ?? request.failover.cooldownMs;
    await ports.breaker.open(provider, reason, cooldownMs);
    const cooldownNote = reportedMs !== null ? 'provider-reported reset time' : 'default cooldown';
    log(
      'provider_breaker_open',
      `breaker opened for ${provider} (${reason}) — provider skipped until cooldown ends (${cooldownNote}, ${Math.ceil(cooldownMs / 60_000)}m)`,
      { failoverReason: reason, ...(kind ? { providerFailureKind: kind } : {}) },
    );
  };

  const gateDeps = { router: ports.router, breaker: ports.breaker, log };
  const preferFallbackWhenProviderIsOpen = providerFallbackPreferrer(gateDeps);

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
    // Record which .NET lane variables BUILD/CHECK/rework children get (#1911).
    const dotnet = dotnetEnvReport(ports.workspace.path, process.env, runId);
    if (dotnet) log('environment_dotnet', describeDotnetEnv(dotnet));
    // Resolve standards ONCE against the fresh worktree (Invariant 1). Resolving again
    // later would let the build worker author the standards it is graded by.
    const constitution = ports.resolveConstitution();
    log('constitution', describeConstitutionSource(constitution, request.product));
    // Pre-PLAN config preflight (#2585/#2586), shared with `factory doctor` via lintFactoryConfig (#2612).
    // An unknown `checkers:` entry would only fail closed in CHECK, after PLAN and BUILD spent model calls;
    // unfilled scaffold tokens would ship a placeholder. Read-only, no subprocess, runs for localOnly too.
    // Any failing verdict parks with the `config` cause (#2587); checker findings come first in the message.
    const lint = lintFactoryConfig({ constitution, configFile: request.repoConfigFile });
    if (lint.verdict !== 'ok') {
      return await terminalParked(
        'config',
        [
          'config preflight failed before PLAN:',
          ...lint.findings.map((f) => f.message),
          `then run factory unpark ${request.issue}`,
        ].join('\n'),
      );
    }

    // Pre-PLAN base health (#2339): a red origin/main releases the issue before any model spend;
    // the CLI turns `released` into LaneEnvironmentPauseError, whose runLane branch writes the base hold.
    if (ports.checkBaseHealth && !request.localOnly) {
      const health = await ports
        .checkBaseHealth({
          worktree: ports.workspace.path,
          constitution,
          router: ports.router,
          env: laneEnv(appPort, process.env, appBaseUrl, ports.workspace.path, runId),
          cachePath: request.baselineCachePath,
          timeoutSeconds: request.timeouts.check,
          testsTimeoutSeconds: request.timeouts.tests,
          compileTimeoutSeconds: request.timeouts.compile,
          log: (type, msg) => log(type, msg),
        })
        .catch((err): undefined => {
          log('environment_warning', `base health check failed: ${errorMessage(err)} — continuing to PLAN`);
          return undefined;
        });
      if (health?.kind === 'red' && health.baseSha !== undefined) {
        log(
          'environment-released',
          `origin/main ${health.baseSha.slice(0, 8)} fails ${health.failingChecks.join(', ')} before PLAN — no model calls, releasing #${request.issue} to queued`,
        );
        return {
          state: 'released',
          reason: 'environment',
          branch: request.branch,
          reworkRounds: 0,
          baseSha: health.baseSha,
          failingChecks: health.failingChecks,
          ...(health.awaitingCi ? { awaitingCi: true } : {}),
          ...(health.confirmedLocally ? { confirmedLocally: true } : {}),
        };
      }
    }

    // Run-start HEAD (#1210): captured exactly once, before PLAN, for local-only
    // workspace runs — there is no remote to diff against, and every rework round
    // inside CHECK must diff against this same base rather than a moving target.
    runStartDiffBase = request.localOnly ? await captureDiffBase(ports.workspace.path) : undefined;
    // PLAN
    const planStartedMs = Date.now();
    let planRoute: BuildRoute;
    let planSlice: PlanResult['slice'];
    let buildDiffBase: string | undefined;
    let builtRoute: BuildRoute;
    let builtModel: string;
    let pinNote: string | undefined;
    let buildMinutes: number;
    if (request.resumeFrom) {
      const resumed = request.resumeFrom;
      ports.events('check')(
        'check',
        `resuming #${request.issue} from CHECK on kept branch ${request.branch} — PLAN and BUILD skipped`,
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
      const planModel = await preferFallbackWhenProviderIsOpen(
        request.modelPins.plan,
        request.modelPins.planFallback,
        'PLAN',
      );
      // A pinned build model determines the route (#1367): an explicit repo `route` still wins, but
      // without one the pin's harness decides, so PLAN cannot send an Anthropic-pinned build to Codex.
      // decideBuildRoute holds the guards (local-only forces codex in PLAN and a pin must not undo it;
      // a codex pin cannot force codex while codex is disabled) so status and the watchdog agree.
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

      const reusablePlan = async () => {
        if (!ports.planReuse) return null;
        let hit: Awaited<ReturnType<PlanReuseStore['load']>> = null;
        try {
          hit = await ports.planReuse.load(issueBodyHash(request.work.brief));
        } catch (err) {
          log('environment_warning', `could not read the plan-reuse record: ${errorMessage(err)} — planning`);
        }
        try {
          await ports.planReuse.clear();
        } catch (err) {
          log('environment_warning', `could not clear the plan-reuse record: ${errorMessage(err)}`);
        }
        if (hit) {
          ports.events('plan')(
            'plan_reused',
            `reusing frozen plan ${request.specPath} for #${request.issue} — body unchanged since the environment release, no PLAN model call`,
          );
        }
        return hit;
      };
      const plan =
        (await reusablePlan()) ??
        (await planPhase({
          previousAttempt: previousAttemptNote,
          issue: request.issue,
          repo: request.repo,
          worktree: ports.workspace.path,
          specPath: request.specPath,
          constitution,
          router: ports.router,
          sandbox: request.sandboxPolicy,
          octokit: ports.octokit,
          log: ports.events('plan'),
          timeoutSeconds: request.timeouts.plan,
          modelOverride: planModel,
          modelFallbacks:
            planModel === request.modelPins.plan && request.modelPins.planFallback
              ? [request.modelPins.planFallback]
              : undefined,
          onProviderFailure: rememberProviderFailure,
          branch: request.branch,
          approvalGate: request.options.approvePlan ? ports.createApprovalGate?.() : undefined,
          drainSteering: request.options.approvePlan ? ports.drainSteering : undefined,
          codexDisabled: request.codexDisabled,
          localOnly: request.localOnly,
          laneId: request.lane,
          workSource: request.workSource,
          enforceReadiness: true,
          fastPath: request.efficiency.fastPath,
          enforceSizeGate: !request.noPr && (request.sizeGateMode ?? 'file') !== 'off',
          sizeGateMode: request.sizeGateMode,
          sliceIndex: request.sliceIndex,
          maxSlices: request.maxSlices,
          sizeBudget: request.sizeBudget,
          blockUnresolvedRegressions: request.blockUnresolvedRegressions,
          updateIssueBodyOnEnrich: request.noPr ? false : request.readinessUpdateIssueBody,
          preferredRoute: pinnedRoute,
          onWorkerResult: phaseLogger.plan,
        }));
      route = plan.route;
      if (!plan.ok) {
        if (plan.stackWait) return stackWaitOutcome(plan.stackWait, request.branch, route);
        const decomposedChildren = plan.decomposed?.childIssues ?? [];
        if (decomposedChildren.length > 0) {
          await ports.onDecomposed?.(decomposedChildren);
          const childList = decomposedChildren.map((n) => `#${n}`).join(', ');
          return { state: 'escalated', reason: `issue #${request.issue} decomposed into ${childList}`, route };
        }
        if (plan.sliced) {
          return await terminalEscalated(
            `issue #${request.issue} sliced into ${plan.sliced.sliceCount} slice(s): ${plan.escalate ?? 'slice plan recorded'}`,
          );
        }
        if (plan.parkReason === 'config') {
          return await terminalParked('config', planConfigParkMessage(plan, request.issue));
        }
        return await terminalEscalated(`plan escalated: ${plan.escalate ?? 'unknown'}`);
      }
      const planBudget = await assertBudget('PLAN');
      if (planBudget) return planBudget;

      // Same-file lane guard (#1515): before this run claims BUILD, make sure no other
      // in-flight run in this repo already owns a file PLAN just said this run will touch.
      if (ports.laneFileGuard && plan.designArtifact) {
        const touchedFiles = touchedFilesFrom(plan.designArtifact);
        const staleOpts = ports.laneClaimStaleness && { isStale: ports.laneClaimStaleness, log: ports.events('plan') };
        const collision = await ports.laneFileGuard.findCollision(request.repo, request.issue, touchedFiles, staleOpts);
        if (collision) {
          return await terminalParked(
            'held',
            `issue held: #${request.issue} touches ${collision.file}, already claimed by in-flight issue #${collision.issue} — held until that lane finishes`,
          );
        }
        if (touchedFiles.length > 0) {
          await ports.laneFileGuard.register(request.repo, request.issue, touchedFiles);
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

      // BUILD
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
      let breakerBlocked = false;
      if (request.failover.enabled) {
        const providers = [
          ...new Set(
            ports.router
              .resolveAll('build_codex')
              .map((m) => ports.router.registryRef.get(m)?.provider)
              .filter((p): p is string => Boolean(p)),
          ),
        ];
        const gate = await gateBuildOnBreaker({ breaker: ports.breaker, providers, log: ports.events('build') });
        breakerBlocked = gate.codexBlocked;
      }

      // PLAN honors pinnedRoute; re-apply it so a plan port that ignores it cannot route elsewhere.
      let buildRoute = pinnedRoute ?? plan.route;
      let buildModel = request.modelPins.build;
      let buildSwapReason: FailoverReason | undefined;
      if (request.failover.enabled && buildRoute === 'opencode') {
        const gate = await gateOpencodeBuildOnBreaker(gateDeps, {
          opencodeModel: buildModel ?? ports.router.resolveAll('build_opencode')[0],
          routePinned: request.preferredRoute !== undefined,
          codexDisabled: request.codexDisabled || breakerBlocked,
        });
        if (gate?.kind === 'blocked') return await terminalEscalated(`build escalated: ${gate.message}`);
        if (gate?.kind === 'swap') {
          buildRoute = gate.route;
          buildModel = gate.model;
          buildSwapReason = gate.reason;
        }
      }
      if (request.failover.enabled && buildRoute === 'claude') {
        const primaryClaude = buildModel ?? ports.router.resolveAll('build_claude')[0];
        const fallbackCodex = request.modelPins.buildFallback ?? ports.router.resolveAll('build_codex')[0];
        const selected = await preferFallbackWhenProviderIsOpen(primaryClaude, fallbackCodex, 'BUILD');
        if (selected && selected !== primaryClaude) {
          buildRoute = 'codex';
          buildModel = selected;
        }
      }
      if (buildModel) {
        const compatible = routeForBuildModel(ports.router.registryRef, buildModel) === buildRoute;
        if (!compatible) {
          log(
            'model_override_ignored',
            `build model ${buildModel} is incompatible with the ${buildRoute} route${
              buildRoute === request.preferredRoute ? ' pinned by .factory/config.json' : ''
            } — using that route's default worker`,
          );
          buildModel = undefined;
        }
      }

      const build = await buildPhase({
        budgetGuard: budgetStop.guard,
        previousAttempt: previousAttemptNote,
        runId,
        issue: request.issue,
        repo: request.repo,
        worktree: ports.workspace.path,
        specPath: request.specPath,
        branch: request.branch,
        constitution,
        route: buildRoute,
        router: ports.router,
        log: ports.events('build'),
        timeoutSeconds: request.timeouts.build,
        skipCI: request.skipCI,
        disablePublish: Boolean(request.localOnly || request.noPr),
        publishFromBuild: request.publishFromBuild,
        modelOverride: buildModel,
        pinnedModel: buildModel !== undefined && buildModel === request.modelPins.build,
        routePinned: request.preferredRoute !== undefined,
        onWorkerResult: phaseLogger.build,
        codexFallbackModel: request.modelPins.buildFallback ?? ports.router.resolveAll('build_codex')[0],
        onProviderFailure: rememberProviderFailure,
        sandbox: request.sandboxPolicy,
        steering: buildSteering,
        appPort,
        appBaseUrl,
        codexDisabled: request.codexDisabled || breakerBlocked,
        localOnly: request.localOnly,
        autoFailover: { enabled: request.failover.enabled, fallbackModel: request.failover.fallbackModel },
        onPgid,
        laneId: request.lane,
        parentBaseRef: request.parentBaseRef,
        openQuestions: plan.designArtifact?.openQuestions,
      });
      route = build.route;
      if (!build.ok && build.reason !== 'budget_exceeded') {
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
      // #2511: say so when a permitted failover built with something other than the user's pin.
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

    // CHECK
    await setPhase('check');
    const priorFailureSignature = await ports.reworkHistory?.priorSignature(request.issue);
    const checkOpts = {
      budgetGuard: budgetStop.guard,
      runId,
      hermeticGit: request.hermeticGit,
      issue: request.issue,
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
      ...reworkRouteFor(builtRoute, builtModel),
      laneId: request.lane,
      onActivity: ports.onActivity,
      logsDir: request.logsDir,
      onWorkerResult: phaseLogger.rework,
      baselineCachePath: request.baselineCachePath,
    };
    const check = await checkPhase(checkOpts);
    checkSummary = check.summary;
    observed.checkSummary = check.summary;
    reworkRounds = check.reworkRounds;
    const flake = check.flakeRerun;
    if (flake && flake.verdict !== 'not-run' && check.baseline) {
      log(
        'flaky_tests',
        `tests re-run ${flake.verdict} on base ${check.baseline.baseSha.slice(0, 8)} (${flake.mode}${flake.tests.length > 0 ? `: ${flake.tests.join(', ')}` : ''})`,
        {
          flakyTests: {
            sha: check.baseline.baseSha,
            checker: 'tests',
            mode: flake.mode,
            tests: flake.tests,
            verdict: flake.verdict,
            ...(flake.logPath !== undefined ? { logPath: flake.logPath } : {}),
          },
        },
      );
      if (flake.verdict === 'passed' && flake.tests.length > 0 && request.flakyLedgerPath !== undefined) {
        await fileFlakyTests({
          request,
          octokit: ports.octokit,
          log,
          file: request.flakyLedgerPath,
          baseSha: check.baseline.baseSha,
          tests: flake.tests,
          logPath: flake.logPath,
        });
      }
    }
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
      if (failed.environment) {
        const env = failed.environment;
        if (env.cause === 'config') {
          // A config failure fails the same way on every requeue (#2583): park with file, line and fix.
          await clearCheckResume();
          const failure =
            failed.failureSignature !== undefined
              ? { failureSignature: failed.failureSignature, failingChecks: env.failingChecks }
              : undefined;
          return terminalParked(
            'config',
            configParkMessage({
              issue: request.issue,
              failure: env,
              summary: failed.summary,
              constitution,
              configFile: request.repoConfigFile,
            }),
            failure,
          );
        }
        if (!request.localOnly && !request.noPr) {
          try {
            const marker = environmentReleaseMarker(request.issue);
            await upsertMarkerComment({
              octokit: ports.octokit,
              repo: request.repo,
              issue: request.issue,
              marker,
              body: `${renderEnvironmentReleaseComment(env)}\n${marker}`,
            });
          } catch (err) {
            log('environment_warning', `could not post the environment-failure comment: ${errorMessage(err)}`);
          }
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
              issue: request.issue,
              branch: request.branch,
              worktree: ports.workspace.path,
              diffBase: buildDiffBase,
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
          `every failing checker (${env.failingChecks.join(', ')}) also fails on base ${env.baseSha.slice(0, 8)} — no rework, releasing #${request.issue} to queued` +
            (preserve
              ? ` — ${formatPreservedBuildMessage({ issue: request.issue, branch: request.branch, buildMinutes, fixTarget })}`
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
    // Clean check — clear stale cross-run history so a future, genuinely different
    // failure is not mistaken for a repeat of one already resolved.
    await ports.reworkHistory?.clear(request.issue);

    const unshipped = await finishWithoutShip(request, ports, log, {
      route,
      reworkRounds,
      checkSummary,
      diffBase: runStartDiffBase,
    });
    if (unshipped) return unshipped;

    // PR classifier gate (#1724): escalate-only — a B/C floor (or any failure) adds the gate label.
    let reviewRouting: ReviewRouting | undefined;
    if (request.prClassifier) {
      reviewRouting = await resolveReviewRouting({
        worktree: ports.workspace.path,
        fallbackBaseRef: buildDiffBase,
        parentBaseRef: request.parentBaseRef,
        rules: request.prClassifier.rules,
        readChanges: ports.readReviewFloorChanges,
      });
      if (reviewRouting.gated) {
        const label = request.prClassifier.gateLabel;
        const [owner, repoName] = request.repo.split('/');
        const labels = withoutHumanOnlyLabels([label]);
        try {
          if (labels.length > 0) {
            await ports.octokit.rest.issues.addLabels({ owner, repo: repoName, issue_number: request.issue, labels });
          }
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

      // Shadow model verdict (#1725, ADR-0121): recorded only. It runs after the gate is fully
      // decided, so it cannot change the label or merge routing.
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
        shadow = {
          modelClass: null,
          floorClass: reviewRouting.floor,
          finalClass: reviewRouting.floor,
          model: null,
          promptVersion: CLASSIFIER_PROMPT_VERSION,
          policyVersion: classifierPolicyVersion(request.prClassifier.rules),
          diffSha: null,
          adrIds: [],
          costUsd: null,
          claims: [],
          unsupportedClaims: [],
          notInspected: [],
          droppedClaims: 0,
          reason: `classifier error: ${errorMessage(err)}`,
        };
      }
      reviewRouting = { ...reviewRouting, shadow };
      log(
        'pr-classified',
        `shadow — no effect: model ${shadow.modelClass ?? 'null'}${shadow.reason ? ` (${shadow.reason})` : ''}, floor ${shadow.floorClass ?? 'error'}, final ${shadow.finalClass ?? 'error'}`,
        { model: shadow.model ?? undefined, prClassification: toClassificationRecord(shadow) },
      );
    }

    // SHIP
    await setPhase('ship');
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
      { builtRoute, builtModel, reviewRouting, pinNote, planSlice, draftPr: policy.pr?.draft },
    );
    if (shipped.outcome) return shipped.outcome;
    const { ship, parked } = shipped;
    if (parked) return await terminalParked(parked.reason, parked.message, parked.checkFailure, parked.ciFailure);

    if (planSlice) {
      const failure = await recordShippedSlice({
        octokit: ports.octokit,
        repo: request.repo,
        issue: request.issue,
        branch: request.branch,
        plan: planSlice.plan,
        index: planSlice.index,
        ship,
        stackMode: request.sizeGateMode === 'stack',
        log,
      });
      if (failure !== undefined) return await terminalParked('fail', failure);
    }

    if (request.skipCI) {
      log('skip-ci', `skipping CI watch (FACTORY_SKIP_CI=1) — merging on local verify`);
    }
    const readyMsg = ship.alreadyDelivered
      ? `already delivered${ship.prNumber !== undefined ? ` by merged PR #${ship.prNumber}` : ' — branch already landed on main'}`
      : `PR #${ship.prNumber} ${ship.draft ? 'left as draft' : 'ready for review'}`;
    log('ready', pinNote ? `${readyMsg} (${pinNote})` : readyMsg);
    await ports.writeLocalRunReport?.({ outcome: 'ready', route, branch: request.branch, reworkRounds });
    return {
      state: 'ready',
      route,
      branch: request.branch,
      reworkRounds,
      prNumber: ship.prNumber,
      ...(ship.draft ? { draft: true } : {}),
      ...(planSlice ? { slice: { index: planSlice.index, count: planSlice.plan.slices.length } } : {}),
    };
  } catch (err) {
    if (isDecomposeSignal(err)) throw err;
    if ((err as { reason?: unknown } | null | undefined)?.reason === 'local_auth') {
      log(
        'environment_warning',
        'provider CLI authentication failed in this launch context (local_auth) — an ops/environment failure, ' +
          'not a failure of the issue itself; on macOS a launch context without login-keychain access (e.g. tmux) ' +
          'cannot refresh Claude OAuth — run `factory doctor` (#1014)',
      );
    }
    return await terminalParked(parkReasonFor(err), errorMessage(err));
  } finally {
    await release();
  }
}
