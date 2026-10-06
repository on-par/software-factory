// packages/core/src/run/run-issue.ts — the per-issue run lifecycle, lifted out of the
// CLI's shipIssue (#675). runIssue(request, policy, ports) sequences PLAN → BUILD →
// CHECK → SHIP and enforces five invariants at this seam:
//   1. the constitution is resolved exactly once, before BUILD, and reused by every phase.
//   2. the per-issue budget is asserted after PLAN, BUILD, and CHECK (parks 'fail' on breach).
//   3. the acquired Environment is released exactly once on every exit path.
//   4. a failed environment lease degrades (appPort undefined) rather than parking the run.
//   5. exactly one terminal event sequence is emitted per run, matching the returned RunOutcome
//      (including the non-park `released` exit for an environment-caused CHECK failure, #1928).
//
// Path-bound CLI concerns (Octokit, worktree/environment provisioning, the events sink,
// approval/steering, and reporting hooks) are injected as ports so this file stays free of
// CLI filesystem layout (ADR-0004). The CLI's shipIssue is a thin adapter that constructs
// these ports and re-raises a parked/escalated outcome as LaneParkError.

import { randomUUID } from 'node:crypto';
import type { Octokit } from '@octokit/rest';

import type { ApprovalGate } from '../approvals/index.js';
import { buildPhase as buildPhaseDefault } from '../phases/build.js';
import { checkPhase as checkPhaseDefault, renderEnvironmentReleaseComment } from '../phases/check.js';
import { planPhase as planPhaseDefault } from '../phases/plan.js';
import { shipPhase as shipPhaseDefault } from '../phases/ship.js';
import type { ReviewFloorPathChange, ReviewFloorRuleSet } from '../review/floor.js';
import {
  CLASSIFIER_PROMPT_VERSION,
  classifierPolicyVersion,
  classifyPrShadow,
  toClassificationRecord,
  type PrClassificationRecord,
  type PrShadowInput,
  type PrShadowVerdict,
} from '../review/classifier.js';
import { resolveReviewRouting, type ReviewRouting } from '../review/routing.js';
import { captureDiffBase } from '../checkers/design-smells.js';
import type { ReworkHistory } from '../checkers/rework-history.js';
import type { AutoFailoverSettings } from '../config/index.js';
import { type EffectiveModelPins, routeForBuildModel } from '../config/repo.js';
import type { EventKind } from '../events/kinds.js';
import { describeDotnetEnv, dotnetEnvReport } from '../environment/dotnet.js';
import { ProcessGroupTracker } from '../environment/process-groups.js';
import type { ModelRouter } from '../router/index.js';
import { gateBuildOnBreaker, parseResetCooldownMs, type ProviderBreaker } from '../router/breaker.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { describeSteering, type ConsumedSteering } from '../steering/index.js';
import type {
  CheckFailureInfo,
  CheckSummary,
  Constitution,
  FailoverReason,
  FailurePhase,
  ReadinessInfo,
} from '../types/index.js';
import type { WorkRequest, WorkRequestSourceKind } from '../work/index.js';
import type { LaneFileGuard } from './lane-file-guard.js';
import { touchedFilesFrom } from './lane-file-guard.js';
import { parkReasonFor, type BuildRoute, type ParkReason, type RunOutcome } from './outcome.js';
import type { RunPolicy } from './policy.js';
import type { Environment, Workspace } from './ports.js';

/** Everything one run needs decided, as a plain resolved value — the CLI adapter
 *  computes this today; no config/file/path resolution happens in here. */
export interface RunRequest {
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
  /** PR classifier gate (#1724). Present only when the setting is on; undefined = off (no git
   *  calls, no label, no event, no evidence-pack section). */
  /** design.blockUnresolvedRegressions resolved (#1819); undefined = off. */
  blockUnresolvedRegressions?: boolean;
  /** build.publishFromBuild resolved (#1867); undefined = off (commit-only BUILD on every route). */
  publishFromBuild?: boolean;
  prClassifier?: { rules: ReviewFloorRuleSet; gateLabel: string; modelPin?: string };
  timeouts: { plan: number; build: number; check: number; approval: number };
  modelPins: EffectiveModelPins;
  codexDisabled: boolean;
  skipCI: boolean;
  failover: AutoFailoverSettings;
  efficiency: { maxReworkRounds: number; fastPath: boolean };
  /** Sandbox containment already resolved against this run's worktree/repoRoot. */
  sandboxPolicy?: SandboxPolicy;
  /** Grace period before escalating to SIGKILL when tearing down tracked process groups. */
  processGroupGraceMs: number;
  /** Repo config pins the build route; forced after PLAN so the frozen spec stays authoritative. */
  preferredRoute?: BuildRoute;
  /** Resolved factory-state paths shipPhase reads/writes directly (unchanged from today —
   *  shipPhase's own surface already takes plain path strings, not a path-resolution port). */
  eventsFile?: string;
  logsDir?: string;
  /** state/baseline-cache.json (#1926), forwarded to checkPhase. */
  baselineCachePath?: string;
}

type LogFn = (
  type: EventKind,
  msg: string,
  extra?: {
    failoverReason?: FailoverReason;
    model?: string;
    tokens?: { input: number; output: number };
    readiness?: ReadinessInfo;
    prClassification?: PrClassificationRecord;
    checkFailure?: CheckFailureInfo;
  },
) => void;

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
export interface RunPorts {
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
   *  undefined, so existing callers/tests that don't wire it see no behavior change. */
  laneFileGuard?: LaneFileGuard;
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
  checkPhase?: typeof checkPhaseDefault;
  shipPhase?: typeof shipPhaseDefault;
  /** Reads the PR's path changes for the classifier (#1724). Defaults to the git-backed reader. */
  readReviewFloorChanges?: (worktree: string, fallbackBaseRef?: string) => Promise<ReviewFloorPathChange[]>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Structural marker for the decompose-hook's thrown signal (core cannot import the
 *  CLI's IssueDecomposedError; see outcome.ts's parkReasonFor for the same convention). */
function isDecomposeSignal(err: unknown): boolean {
  return Array.isArray((err as { childIssues?: unknown } | null | undefined)?.childIssues);
}

export async function runIssue(request: RunRequest, policy: RunPolicy, ports: RunPorts): Promise<RunOutcome> {
  const planPhase = ports.planPhase ?? planPhaseDefault;
  const buildPhase = ports.buildPhase ?? buildPhaseDefault;
  const checkPhase = ports.checkPhase ?? checkPhaseDefault;
  const shipPhase = ports.shipPhase ?? shipPhaseDefault;
  const log = ports.events();
  // One id per run: BUILD, CHECK and rework share a per-run VBCSCompiler server (#1910).
  // 12 hex chars keeps the compiler's Unix-socket pipe path short under macOS $TMPDIR.
  const runId = randomUUID().replace(/-/g, '').slice(0, 12);
  const tracker = new ProcessGroupTracker();
  let environment: Environment | undefined;
  let released = false;
  let route: BuildRoute | undefined;
  let reworkRounds: number | undefined;
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
  };

  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    if (laneFileClaimed) {
      laneFileClaimed = false;
      await ports.laneFileGuard?.release(request.repo, request.issue);
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
    log('escalate', message);
    await writeReports('escalated', 'escalate', message);
    return { state: 'escalated', reason: message, route, branch: request.branch, reworkRounds };
  };

  const terminalParked = async (
    reason: ParkReason,
    message: string,
    checkFailure?: { failureSignature: string; failingChecks: string[] },
  ): Promise<RunOutcome> => {
    log(
      reason,
      message,
      checkFailure
        ? { checkFailure: { signature: checkFailure.failureSignature, failingChecks: checkFailure.failingChecks } }
        : undefined,
    );
    if (reason === 'timeout') {
      log('stuck', `run exceeded its phase timeout without progressing — ${message}`);
    }
    await writeReports(reportOutcomeFor(reason), reason, message);
    return { state: 'parked', reason, route, branch: request.branch, reworkRounds, ...checkFailure };
  };

  const assertBudget = async (phase: string): Promise<RunOutcome | undefined> => {
    const spend = ports.getIssueSpend?.() ?? 0;
    const cap = policy.budget.perIssueCapUsd;
    if (cap === undefined || spend <= cap) return undefined;
    const message = `per-issue budget exceeded after ${phase}: $${spend.toFixed(2)} > $${cap.toFixed(2)}`;
    log('budget_exceeded', message);
    return terminalParked('fail', message);
  };

  const rememberProviderFailure = async ({
    provider,
    reason,
    detail,
  }: {
    provider: string;
    reason: FailoverReason;
    detail?: string;
  }): Promise<void> => {
    const reportedMs = parseResetCooldownMs(detail ?? '');
    const cooldownMs = reportedMs ?? request.failover.cooldownMs;
    await ports.breaker.open(provider, reason, cooldownMs);
    const cooldownNote = reportedMs !== null ? 'provider-reported reset time' : 'default cooldown';
    log(
      'provider_breaker_open',
      `breaker opened for ${provider} (${reason}) — provider skipped until cooldown ends (${cooldownNote}, ${Math.ceil(cooldownMs / 60_000)}m)`,
      { failoverReason: reason },
    );
  };

  const preferFallbackWhenProviderIsOpen = async (
    primary: string | undefined,
    fallback: string | undefined,
    phase: string,
  ): Promise<string | undefined> => {
    if (!primary || !fallback) return primary;
    const provider = ports.router.registryRef.get(primary)?.provider;
    if (!provider) return primary;
    const status = await ports.breaker.status(provider);
    if (!status.open) return primary;
    const minutes = Math.ceil(status.remainingMs / 60_000);
    log(
      'provider_breaker_skip',
      `breaker open for ${provider} (${status.entry.reason}) — using ${fallback} for ${phase}, ${minutes}m remaining`,
    );
    return fallback;
  };

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
    if (constitution) {
      log(
        'constitution',
        constitution.source === 'repo'
          ? `Standards from repo instruction files${request.product ? ` (custom checkers from '${request.product}')` : ''}`
          : `Standards from bundled constitution '${constitution.product}'`,
      );
    } else {
      log('constitution', 'No standards found (no repo instruction files, no constitution) — proceeding without');
    }

    // Run-start HEAD (#1210): captured exactly once, before PLAN, for local-only
    // workspace runs — there is no remote to diff against, and every rework round
    // inside CHECK must diff against this same base rather than a moving target.
    runStartDiffBase = request.localOnly ? await captureDiffBase(ports.workspace.path) : undefined;

    // PLAN
    await setPhase('plan');
    const planModel = await preferFallbackWhenProviderIsOpen(
      request.modelPins.plan,
      request.modelPins.planFallback,
      'PLAN',
    );
    // A pinned build model determines the route (#1367): an explicit repo `route` still wins, but
    // without one the pin's harness decides, so PLAN cannot send an Anthropic-pinned build to Codex.
    // Two guards keep the pin from resurrecting a route the operator turned off: local-only mode
    // forces codex in PLAN and a pin must not undo that; and a codex pin while codex is disabled
    // cannot force codex — PLAN's codex→claude fallback applies and the compatibility check below
    // drops the pin, exactly as on main.
    let derivedRoute =
      request.preferredRoute || request.localOnly
        ? undefined
        : routeForBuildModel(ports.router.registryRef, request.modelPins.build);
    if (derivedRoute === 'codex' && request.codexDisabled) {
      log(
        'model-override',
        `pinned build model ${request.modelPins.build} needs the codex route but codex is disabled — the pin cannot force it`,
      );
      derivedRoute = undefined;
    }
    const pinnedRoute = request.preferredRoute ?? derivedRoute;
    if (derivedRoute) {
      log('model-override', `build route derived from pinned build model ${request.modelPins.build} → ${derivedRoute}`);
    }

    const plan = await planPhase({
      issue: request.issue,
      repo: request.repo,
      worktree: ports.workspace.path,
      specPath: request.specPath,
      constitution,
      router: ports.router,
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
      enforceSizeGate: true,
      blockUnresolvedRegressions: request.blockUnresolvedRegressions,
      preferredRoute: pinnedRoute,
    });
    route = plan.route;
    if (!plan.ok) {
      const decomposedChildren = plan.decomposed?.childIssues ?? [];
      if (decomposedChildren.length > 0) {
        await ports.onDecomposed?.(decomposedChildren);
        const childList = decomposedChildren.map((n) => `#${n}`).join(', ');
        return { state: 'escalated', reason: `issue #${request.issue} decomposed into ${childList}`, route };
      }
      return terminalEscalated(`plan escalated: ${plan.escalate ?? 'unknown'}`);
    }
    const planBudget = await assertBudget('PLAN');
    if (planBudget) return planBudget;

    // Same-file lane guard (#1515): before this run claims BUILD, make sure no other
    // in-flight run in this repo already owns a file PLAN just said this run will touch.
    if (ports.laneFileGuard && plan.designArtifact) {
      const touchedFiles = touchedFilesFrom(plan.designArtifact);
      const collision = await ports.laneFileGuard.findCollision(request.repo, request.issue, touchedFiles);
      if (collision) {
        return terminalParked(
          'held',
          `issue held: #${request.issue} touches ${collision.file}, already claimed by in-flight issue #${collision.issue} — held until that lane finishes`,
        );
      }
      if (touchedFiles.length > 0) {
        await ports.laneFileGuard.register(request.repo, request.issue, touchedFiles);
        laneFileClaimed = true;
      }
    }

    // BUILD
    await setPhase('build');
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

    // PLAN already honors pinnedRoute and rewrites the spec; re-apply here so a plan port that
    // ignores it (a daemon or a test double) still cannot route a pinned worker elsewhere.
    let buildRoute = pinnedRoute ?? plan.route;
    let buildModel = request.modelPins.build;
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
      const harnessId = ports.router.registryRef.getHarnessId(buildModel);
      const compatible =
        buildRoute === 'codex'
          ? ports.router.registryRef.isCodexModel(buildModel)
          : buildRoute === 'opencode'
            ? harnessId === 'opencode'
            : harnessId === 'claude-cli';
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
      disablePublish: Boolean(request.localOnly),
      publishFromBuild: request.publishFromBuild,
      modelOverride: buildModel,
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
    });
    route = build.route;
    if (!build.ok) {
      if (build.reason === 'no_diff') {
        return terminalParked('fail', 'build produced no diff against the base ref — no implementation was produced');
      }
      if (build.reason === 'junk_only_diff') {
        return terminalParked(
          'fail',
          'build changed only generated/cache files (e.g. __pycache__) — no implementation was produced',
        );
      }
      return terminalEscalated(`build escalated: ${build.escalate ?? 'unknown'}`);
    }
    const buildBudget = await assertBudget('BUILD');
    if (buildBudget) return buildBudget;

    // CHECK
    await setPhase('check');
    const priorFailureSignature = await ports.reworkHistory?.priorSignature(request.issue);
    const check = await checkPhase({
      runId,
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
      sandbox: request.sandboxPolicy,
      drainSteering: request.options.interactive ? ports.drainSteering : undefined,
      appPort,
      appBaseUrl,
      onPgid,
      priorFailureSignature,
      diffBase: request.localOnly ? runStartDiffBase : build.diffBase,
      reworkRoute: build.route,
      reworkModel: build.model,
      laneId: request.lane,
      onActivity: ports.onActivity,
      logsDir: request.logsDir,
      baselineCachePath: request.baselineCachePath,
    });
    checkSummary = check.summary;
    reworkRounds = check.reworkRounds;
    const checkBudget = await assertBudget('CHECK');
    if (checkBudget) return checkBudget;
    if (!check.passed) {
      if (check.environment) {
        const env = check.environment;
        if (!request.localOnly) {
          const [owner, repoName] = request.repo.split('/');
          try {
            await ports.octokit.rest.issues.createComment({
              owner,
              repo: repoName,
              issue_number: request.issue,
              body: renderEnvironmentReleaseComment(env),
            });
          } catch (err) {
            log('environment_warning', `could not post the environment-failure comment: ${errorMessage(err)}`);
          }
        }
        log(
          'environment-released',
          `every failing checker (${env.failingChecks.join(', ')}) also fails on base ${env.baseSha.slice(0, 8)} — no rework, releasing #${request.issue} to queued`,
        );
        return {
          state: 'released',
          reason: 'environment',
          route,
          branch: request.branch,
          reworkRounds: 0,
          baseSha: env.baseSha,
          failingChecks: env.failingChecks,
          ...(check.failureSignature !== undefined ? { failureSignature: check.failureSignature } : {}),
        };
      }
      const checkFailure =
        check.failureSignature !== undefined
          ? {
              failureSignature: check.failureSignature,
              failingChecks: check.summary.results.filter((r) => r.result === 'FAIL').map((r) => r.checker),
            }
          : undefined;
      if (checkFailure) {
        await ports.reworkHistory?.record(request.issue, checkFailure.failureSignature, checkFailure.failingChecks);
      }
      const reason: ParkReason = check.crossRunStuck ? 'held' : check.stuck ? 'escalate' : 'fail';
      const message = check.crossRunStuck
        ? `issue held: identical failure signature parked this lane in a prior run too (${check.reworkRounds} rework rounds burned there, 0 here) — needs a human decision`
        : check.stuck
          ? `lane stuck after ${check.reworkRounds} rework rounds (identical failures) — escalated`
          : `${check.summary.failures} check failures after ${check.reworkRounds} rework rounds`;
      return terminalParked(reason, message, checkFailure);
    }
    // Clean check — clear stale cross-run history so a future, genuinely different
    // failure is not mistaken for a repeat of one already resolved.
    await ports.reworkHistory?.clear(request.issue);

    if (request.localOnly) {
      log(
        'local-only-complete',
        `local-only run complete in ${ports.workspace.path} — publishing disabled, no PR created`,
      );
      const reportPath = await ports.writeLocalRunReport?.({
        outcome: 'ready',
        route,
        branch: request.branch,
        reworkRounds,
      });
      await ports.writeBenchmarkArtifacts?.({
        outcome: 'ready',
        route,
        branch: request.branch,
        reworkRounds,
        checkSummary,
        reportPath,
        diffBase: runStartDiffBase,
      });
      return { state: 'ready', route, branch: request.branch, reworkRounds };
    }

    // PR classifier gate (#1724): escalate-only — a B/C floor (or any failure) adds the gate label.
    let reviewRouting: ReviewRouting | undefined;
    if (request.prClassifier) {
      reviewRouting = await resolveReviewRouting({
        worktree: ports.workspace.path,
        fallbackBaseRef: build.diffBase,
        rules: request.prClassifier.rules,
        readChanges: ports.readReviewFloorChanges,
      });
      if (reviewRouting.gated) {
        const label = request.prClassifier.gateLabel;
        const [owner, repoName] = request.repo.split('/');
        try {
          await ports.octokit.rest.issues.addLabels({
            owner,
            repo: repoName,
            issue_number: request.issue,
            labels: [label],
          });
        } catch (err) {
          return terminalParked(
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
        fallbackBaseRef: build.diffBase,
        issueTitle: request.work.title,
        issueBody: request.work.brief,
        specPath: request.specPath,
        floor: reviewRouting.floor,
        floorRules: reviewRouting.rules,
        rules: request.prClassifier.rules,
        modelPin: request.prClassifier.modelPin,
        router: ports.router,
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
    const ship = await shipPhase({
      issue: request.issue,
      repo: request.repo,
      worktree: ports.workspace.path,
      branch: request.branch,
      recordedRemoteSha: ports.workspace.remoteBranch?.sha,
      octokit: ports.octokit,
      watchCI: !request.skipCI,
      log: ports.events('ship'),
      approvalGate: request.options.interactive ? ports.createApprovalGate?.() : undefined,
      checkSummary: check.summary,
      specPath: request.specPath,
      eventsFile: request.eventsFile,
      startedAt: request.startedAt,
      logsDir: request.logsDir,
      reworkRounds: check.reworkRounds,
      work: request.work,
      laneId: request.lane,
      reviewRouting,
    });
    if (!ship.ok) {
      const reason: ParkReason = ship.denied ? 'escalate' : 'fail';
      const message = ship.denied
        ? `ship denied: ${ship.deniedReason}`
        : ship.reason
          ? `ship phase failed: ${ship.reason}`
          : 'ship phase failed';
      return terminalParked(reason, message);
    }

    if (request.skipCI) {
      log('skip-ci', `skipping CI watch (FACTORY_SKIP_CI=1) — merging on local verify`);
    }
    const readyMsg = ship.alreadyDelivered
      ? `already delivered${ship.prNumber !== undefined ? ` by merged PR #${ship.prNumber}` : ' — branch already landed on main'}`
      : `PR #${ship.prNumber} ready for review`;
    log('ready', readyMsg);
    await ports.writeLocalRunReport?.({ outcome: 'ready', route, branch: request.branch, reworkRounds });
    return { state: 'ready', route, branch: request.branch, reworkRounds, prNumber: ship.prNumber };
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
    return terminalParked(parkReasonFor(err), errorMessage(err));
  } finally {
    await release();
  }
}
