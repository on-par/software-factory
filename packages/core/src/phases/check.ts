// src/phases/check.ts — CHECK phase: independent checkers verify output, rework loop

import { join } from 'node:path';

import { type LifecycleBus, withLifecycle } from '../bus/index.js';
import { type BaselineReport, extractFailingTestNames, runBaselineCheckers } from '../checkers/baseline.js';
import { type FlakeRerun, rerunTestsChecker } from '../checkers/flaky-rerun.js';
import {
  type CheckerContext,
  isConfigCheckerOutput,
  probeWorktree,
  renderCheckerFindings,
  runAllCheckers,
} from '../checkers/index.js';
import { describeCheckOutcome } from '../checkers/check-outcome.js';
import { detectHeadedModeSignals, detectLiveAppSignal } from './check-environment.js';
import { environmentLogPaths } from './environment-release.js';
import { infraTriage } from './check-infra-triage.js';
import { markBuildFilesIntentToAdd } from './check-intent-to-add.js';
import { appendEvidencePlanStep } from './check-evidence.js';
import type { runEvidencePlan } from '../checkers/evidence-plan.js';
import { buildConstitutionContext } from '../constitutions/index.js';
import type { BuildRoutePin } from '../config/repo.js';
import type { TestsAffectedConfig } from '../config/tests-section.js';
import { hermeticGitEnv, laneEnv } from '../environment/index.js';
import { sandboxEnvFromSummary, sandboxEnvParkMessage } from '../environment/sandbox-env.js';
import type { EventKind } from '../events/kinds.js';
import { type BudgetGuard, isBudgetStopError } from '../router/budget-guard.js';
import { routerFailureOf } from '../router/executor-error.js';
import type { ModelRouter, RouterResult } from '../router/index.js';
import { failoversFrom } from '../router/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { applySteering, type ConsumedSteering, describeSteering } from '../steering/index.js';
import type { RequiredChecksVerdict } from '../utils/required-checks.js';
import { baselineCacheOptions, describeBaseline } from './check-baseline.js';
import { LENS_REVIEW_CHECKER, lensShowstopperRefs, remainingShowstoppers } from './check-showstoppers.js';
import { affectedVerifyInstruction, createAffectedSelector, fullTestsBeforeShip } from './check-affected.js';
import { resolveReworkRoute } from './plan-routes.js';

export { LENS_REVIEW_CHECKER, lensShowstopperRefs, remainingShowstoppers };
import type {
  BaseFailureCause,
  CheckerOutput,
  CheckSummary,
  Constitution,
  FailoverReason,
  ReworkCause,
  ReworkInfo,
} from '../types/index.js';

type LogFn = (
  type: EventKind,
  msg: string,
  extra?: { failoverReason?: FailoverReason; rework?: ReworkInfo; durationMs?: number },
) => void;

/** A CHECK failure caused by the base, not the issue (#1928). */
export interface EnvironmentFailure {
  /** diffBase the baseline ran on (BaselineReport.baseSha). */
  baseSha: string;
  /** Round-1 FAIL checker names, in summary order. */
  failingChecks: string[];
  /** 'config' when a failing checker is an unknown-checker constitution error (#2581), else 'environment'. */
  cause: BaseFailureCause;
  /** Full-output log files from round 1 plus the base-run log dir; empty when logsDir is unset. */
  logPaths: string[];
}

export interface CheckPhaseResult {
  passed: boolean;
  summary: CheckSummary;
  reworkRounds: number;
  stuck?: boolean;
  /** True when round one's failure signature already matched `priorFailureSignature`
   *  (#740) — the rework loop was skipped entirely (0 rounds burned) rather than
   *  re-running a full budget against a root cause a prior run already exhausted
   *  its rework budget on without fixing. Always implies `stuck: true`. */
  crossRunStuck?: boolean;
  /** Signature of the final failing checks, persisted via ReworkHistory to spot repeats; absent on a clean pass. */
  failureSignature?: string;
  /** Round-1 failing checkers re-run on diffBase (#1925); absent when round 1 passed, worker_output failed, or no diffBase. */
  baseline?: BaselineReport;
  /** Set when every round-1 failing checker also fails on the base SHA (#1928): no rework
   *  ran (`reworkRounds` is 0) and the caller releases the issue instead of parking it. */
  environment?: EnvironmentFailure;
  /** Serial re-run of the failing tests checker on an environment failure (#2301, #2302). On 'passed', tests counts as PASS in summary and the run continues unless another checker still fails on base; absent when tests did not fail or the cause is not environment. */
  flakeRerun?: FlakeRerun;
  /** Set when tests hit the verify.sh sandbox marker (#3332): the park message; no baseline or rework ran. */
  sandboxEnv?: string;
  /** Set when every lane-owned FAIL was infra and a network/missing-tool failure repeated on the one free re-run (#3371): the park message; no rework ran. */
  infra?: string;
}

export const MAX_REWORK_ROUNDS = 3;

/** Consecutive no-progress rework rounds before the lane is declared stuck. */
const STUCK_THRESHOLD = 2;

/** Provider/CI-level reasons that point away from a factory fault. */
const EXTERNAL_REASONS = new Set<FailoverReason>([
  'rate_limit',
  'usage_cap',
  'timeout',
  'unavailable',
  'local_auth',
  'cli_missing',
]);

/** Deterministic signature of the failing checks: name + volatility-stripped detail. */
function failureSignature(summary: CheckSummary): string {
  return summary.results
    .filter((r) => r.result === 'FAIL')
    .map((r) => `${r.checker}:${signatureDetail(r)}`)
    .sort()
    .join('|');
}

/** lens_review is signed by its showstopper refs (LLM prose drifts each round, #2238); everything else by normalized detail. */
function signatureDetail(r: CheckerOutput): string {
  if (r.checker === LENS_REVIEW_CHECKER) {
    const refs = lensShowstopperRefs(r.details);
    if (refs.length > 0) return refs.join(',');
  }
  return normalizeDetail(r.details);
}

function normalizeDetail(details: string): string {
  return details.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function failingCheckerNames(summary: CheckSummary): string[] {
  return summary.results.filter((r) => r.result === 'FAIL').map((r) => r.checker);
}

const MAX_FAILING_TESTS = 3;
const MAX_FAILURE_OUTPUT_LENGTH = 400;

/** Bounded test-failure evidence for rework events; absent unless the tests checker failed. */
function testFailureEvidence(summary: CheckSummary): Pick<ReworkInfo, 'failingTests' | 'failureOutput'> {
  const testsFailure = summary.results.find((result) => result.checker === 'tests' && result.result === 'FAIL');
  if (!testsFailure) return {};

  const details = testsFailure.details.slice(0, MAX_FAILURE_OUTPUT_LENGTH);
  const failingTests = extractFailingTestNames(details).slice(0, MAX_FAILING_TESTS);

  return {
    ...(failingTests.length > 0 ? { failingTests } : {}),
    ...(details !== '' ? { failureOutput: details } : {}),
  };
}

function classifyReworkCause(opts: {
  steering?: ConsumedSteering;
  failovers: { reason: FailoverReason }[];
  /** Reason from a router error when the call threw before any model produced output (#642). */
  failureReason?: FailoverReason;
  /** A config-validation FAIL (unknown checker, schema error, unfilled placeholder) drove the round (#2582). */
  config?: boolean;
}): ReworkCause {
  if (opts.steering && opts.steering.messages.length > 0) return 'direction-change';
  if (opts.failovers.some((f) => EXTERNAL_REASONS.has(f.reason))) return 'external';
  if (opts.failureReason !== undefined && EXTERNAL_REASONS.has(opts.failureReason)) return 'external';
  if (opts.config) return 'config';
  return 'factory-fault';
}

/** 'config' when any FAIL is a config-validation error (unknown checker, schema error, unfilled placeholder; #2581/#2582); otherwise 'environment'. */
export function classifyBaseFailureCause(summary: CheckSummary): BaseFailureCause {
  return summary.results.some(isConfigCheckerOutput) ? 'config' : 'environment';
}

/** True when every round-1 failing checker also fails on the base SHA (#1927): the failure
 *  belongs to the environment/base, not the lane. False without a usable baseline, on any
 *  clean-on-base or not-run failing checker, or when nothing failed. */
export function isEnvironmentFailure(summary: CheckSummary, baseline: BaselineReport | undefined): boolean {
  if (!baseline || baseline.error !== undefined) return false;
  const failing = failingCheckerNames(summary);
  if (failing.length === 0) return false;
  return failing.every((name) => baseline.checkers.some((c) => c.checker === name && c.verdict === 'fails-on-base'));
}

/** Checkers rework ignores on partial overlap (#1929): fails-on-base with no new failing tests. Empty without a usable baseline. */
export function baseFailingCheckers(baseline: BaselineReport | undefined): Set<string> {
  if (!baseline || baseline.error !== undefined) return new Set();
  return new Set(
    baseline.checkers
      .filter((c) => c.verdict === 'fails-on-base' && !(c.newFailingTests && c.newFailingTests.length > 0))
      .map((c) => c.checker),
  );
}

/** The summary without the FAIL results of excluded (base-failing) checkers. */
export function excludeBaseFailing(summary: CheckSummary, excluded: ReadonlySet<string>): CheckSummary {
  if (excluded.size === 0) return summary;
  const results = summary.results.filter((r) => !(r.result === 'FAIL' && excluded.has(r.checker)));
  return {
    ...summary,
    results,
    failures: results.filter((r) => r.result === 'FAIL').length,
    total: results.length,
  };
}

/** Failure signature over the lane-owned failures; falls back to the full signature when the
 *  filter leaves none, so a failing CHECK never gets an empty signature. */
export function stuckSignature(summary: CheckSummary, excluded: ReadonlySet<string>): string {
  const target = excludeBaseFailing(summary, excluded);
  return failureSignature(target.failures > 0 ? target : summary);
}

/** The summary with the tests FAIL replaced by a PASS after a passing serial re-run (#2302). */
export function markTestsFlaky(summary: CheckSummary, rerun: FlakeRerun): CheckSummary {
  const names = rerun.tests.length > 0 ? rerun.tests.join(', ') : 'full suite';
  const results = summary.results.map((r) =>
    r.checker === 'tests' && r.result === 'FAIL'
      ? { checker: r.checker, result: 'PASS' as const, details: `re-run passed; flaky: ${names}` }
      : r,
  );
  return {
    ...summary,
    results,
    failures: results.filter((r) => r.result === 'FAIL').length,
    passes: results.filter((r) => r.result === 'PASS').length,
  };
}

export async function checkPhase(opts: Parameters<typeof checkPhaseImpl>[0]): Promise<CheckPhaseResult> {
  return withLifecycle(
    {
      bus: opts.bus,
      phase: 'check',
      laneId: opts.laneId,
      issueId: opts.issue,
      worktreePath: opts.worktree,
      log: opts.log,
    },
    () => checkPhaseImpl(opts),
    (r) => r.passed,
    (r) =>
      `check ${r.passed ? 'passed' : 'failed'} (${r.summary.passes} pass, ${r.summary.failures} fail, ` +
      `${r.reworkRounds} rework round${r.reworkRounds === 1 ? '' : 's'})`,
  );
}

async function checkPhaseImpl(opts: {
  issue: number;
  worktree: string;
  specPath: string;
  constitution: Constitution | null;
  router: ModelRouter;
  log: LogFn;
  autoRework?: boolean;
  /** Hard cap for checker repair attempts. Defaults to one to avoid full-session retry loops. */
  maxReworkRounds?: number;
  buildTimeoutSeconds?: number;
  checkTimeoutSeconds?: number;
  /** Timeout for the tests checker command (`timeouts.tests_seconds`, #2299). */
  testsTimeoutSeconds?: number;
  compileTimeoutSeconds?: number;
  sandbox?: SandboxPolicy;
  drainSteering?: () => ConsumedSteering;
  appPort?: number;
  /** Stable lane URL from the factory proxy (e.g. http://<lane>.factory.localhost), when running. */
  appBaseUrl?: string;
  onPgid?: (pgid: number) => void;
  budgetGuard?: BudgetGuard; // per-issue budget guard for rework sessions (#3320)
  processGroupTracker?: CheckerContext['processGroupTracker'];
  /** Signature a prior run parked on (ReworkHistory, #740); a round-one match skips the rework loop. */
  priorFailureSignature?: string;
  /** Fallback diff base for workerOutputChecker and designSmellsChecker in checkouts
   *  with no remote base ref (#1211, #1212). For localOnly runs this is the run-start
   *  HEAD captured once in runIssue before PLAN (#1210); otherwise it is buildPhase's
   *  pre-worker HEAD. */
  diffBase?: string;
  /** Parent ref of a stacked slice (#2716); forwarded to CheckerContext.parentBaseRef. */
  parentBaseRef?: string;
  reviewFloorRules?: CheckerContext['reviewFloorRules']; // design_smells class-A skip (#3374)
  /** Worker route that completed BUILD (`command` included, #2873); direct callers retain Claude rework by default. */
  reworkRoute?: BuildRoutePin;
  /** Worker model that completed BUILD, retained as the compatible rework override. */
  reworkModel?: string;
  /** Lane id stamped onto emitted lifecycle events; defaults to `issue-<issue>` (#591). */
  laneId?: string;
  /** Per-run id minted by runIssue; becomes SharedCompilationId=factory-<runId> for .NET lanes (#1910). */
  runId?: string;
  /** Lifecycle bus to emit onto; defaults to the process-wide `lifecycleBus` (#591). */
  bus?: LifecycleBus;
  /** Heartbeat hook (#1326) for `CheckerContext.onActivity`; bumps the run-phase snapshot's `lastActivityAt`. */
  onActivity?: () => void | Promise<void>;
  /** Factory logs dir; failing checker output goes to `<logsDir>/issue-<n>/check-r<round>/` and FAIL links it. */
  logsDir?: string;
  onWorkerResult?: ReworkWorkerOptions['onWorkerResult'];
  /** state/baseline-cache.json (#1926); when set, baseline results are cached per base SHA + laneEnv hash. */
  baselineCachePath?: string;
  /** check.baselineCacheTtlHours (#3540); undefined = 24. */
  baselineCacheTtlHours?: number;
  /** GitHub CI verdict for the base SHA (#3540); absent = cached FAILs are never cross-checked. */
  requiredChecksVerdict?: (sha: string) => Promise<RequiredChecksVerdict>;
  /** Injection seam for tests; defaults to runBaselineCheckers (#1925). */
  runBaseline?: typeof runBaselineCheckers;
  /** Injection seam for tests; defaults to runAllCheckers (#2238). */
  runCheckers?: typeof runAllCheckers;
  /** Empty global/system git config for checker commands (#3272); default true. */
  hermeticGit?: boolean;
  /** Injection seam for the flaky re-run command only (#2301); defaults to ctx.runCommand / runVerificationCommand. */
  runCommand?: CheckerContext['runCommand'];
  /** Injection seam for tests; defaults to the frozen evidence-plan runner. */
  runEvidence?: typeof runEvidencePlan;
  /** Test seam; undefined reads `tests.affected` from the worktree's repo config (#3260). */
  testsAffected?: TestsAffectedConfig | null;
}): Promise<CheckPhaseResult> {
  const {
    issue,
    worktree,
    specPath,
    constitution,
    router,
    log,
    autoRework = true,
    maxReworkRounds = MAX_REWORK_ROUNDS,
    buildTimeoutSeconds,
    checkTimeoutSeconds,
    testsTimeoutSeconds,
    sandbox,
    drainSteering,
    appPort,
    appBaseUrl,
    onPgid,
    budgetGuard,
    processGroupTracker,
    priorFailureSignature,
    diffBase,
    parentBaseRef,
    reworkRoute,
    reworkModel,
    runId,
    onActivity,
    logsDir,
    baselineCachePath,
    baselineCacheTtlHours,
    requiredChecksVerdict,
    runBaseline,
    runCheckers,
    hermeticGit = true,
    runCommand,
    runEvidence,
  } = opts;
  const roundLogDir = (round: number): string | undefined =>
    logsDir === undefined ? undefined : join(logsDir, `issue-${issue}`, `check-r${round}`);
  const checkBaseDir = logsDir === undefined ? undefined : join(logsDir, `issue-${issue}`, 'check-base');
  const selectAffected = createAffectedSelector({ worktree, diffBase, constitution, config: opts.testsAffected, log });
  const checkTriageDir = logsDir === undefined ? undefined : join(logsDir, `issue-${issue}`, 'check-triage');
  // Each failing checker is logged individually, the same way SKIPs are: the parked
  // outcome only carries an aggregate count, so without this the checker/details pairs
  // that name WHY a run parked are never surfaced to the operator (#675).
  const logFailures = (s: CheckSummary): void => {
    for (const f of s.results.filter((r) => r.result === 'FAIL')) {
      const findings = f.findings?.length ? `\n${renderCheckerFindings(f.findings).join('\n')}` : '';
      log('check', `FAILED: ${f.checker} — ${f.details}${findings}`);
    }
  };

  await markBuildFilesIntentToAdd(worktree, log);
  let probe = await probeWorktree(worktree);
  const ctx: CheckerContext = {
    worktree,
    sandbox,
    specPath,
    diffBase,
    parentBaseRef,
    reviewFloorRules: opts.reviewFloorRules,
    env: { ...laneEnv(appPort, process.env, appBaseUrl, worktree, runId), ...hermeticGitEnv(hermeticGit) },
    onPgid,
    processGroupTracker,
    probe,
    log,
    onActivity,
    outputLogDir: roundLogDir(0),
    testsTimeoutSeconds,
    compileTimeoutSeconds: opts.compileTimeoutSeconds,
  };

  if (appPort === undefined) {
    const signal = detectLiveAppSignal(probe);
    if (signal) {
      log(
        'environment_warning',
        `no leased port for this lane but the worktree runs a live app for testing (${signal}) — parallel-lane e2e servers may collide on a shared port; enable environment.ports in factory.json`,
      );
    }
  }

  const headedSignals = detectHeadedModeSignals(probe);
  for (const signal of headedSignals) {
    log(
      'environment_warning',
      `headed e2e config detected (${signal}) — factory-managed runs are headless by default; configs must honor FACTORY_HEADLESS/PLAYWRIGHT_HEADLESS (see the constitution's e2e environment contract)`,
    );
  }

  log('check', 'Running checkers');

  const hermeticGitNote = `hermetic git: ${hermeticGit ? 'on (GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1)' : 'off (check.hermeticGit false)'}`;
  log('check', hermeticGitNote);
  let summary = await (runCheckers ?? runAllCheckers)(ctx, router, constitution, checkTimeoutSeconds);
  summary = await appendEvidencePlanStep(summary, ctx, constitution, runEvidence);
  let reworkRounds = 0;
  const maxRounds = autoRework ? Math.min(maxReworkRounds, MAX_REWORK_ROUNDS) : 0;

  if (summary.results.some((result) => result.checker === 'worker_output' && result.result === 'FAIL')) {
    const signature = failureSignature(summary);
    log('fail', 'worker produced no implementation diff — parking before rework');
    return { passed: false, summary, reworkRounds: 0, failureSignature: signature };
  }

  const sandboxLine = sandboxEnvFromSummary(summary);
  if (sandboxLine) {
    const sandboxEnv = sandboxEnvParkMessage('check', sandboxLine);
    return { passed: false, summary, reworkRounds: 0, failureSignature: failureSignature(summary), sandboxEnv };
  }

  let baseline: BaselineReport | undefined;
  if (
    summary.results.some(
      (result) => !['evidence_plan', 'side_effects'].includes(result.checker) && result.result === 'FAIL',
    )
  ) {
    if (diffBase === undefined) {
      log('check', 'baseline skipped: no base SHA for this run');
    } else {
      baseline = await (runBaseline ?? runBaselineCheckers)({
        baseSha: diffBase,
        laneWorktree: worktree,
        failing: summary.results.filter(
          (result) => !['evidence_plan', 'side_effects'].includes(result.checker) && result.result === 'FAIL',
        ),
        ctx: {
          ...ctx,
          outputLogDir: checkBaseDir,
        },
        router,
        constitution,
        customCheckerTimeoutSeconds: checkTimeoutSeconds,
        ...baselineCacheOptions(baselineCachePath, baselineCacheTtlHours, requiredChecksVerdict, (checker, reason) =>
          log('baseline-cache-invalidated', `baseline cache invalidated: ${diffBase} ${checker} — ${reason}`),
        ),
      }).catch((e: any) => ({ baseSha: diffBase, checkers: [], error: String(e?.message ?? e).slice(0, 300) }));
      log('check', describeBaseline(baseline));
    }
  }

  // Decided before the rework loop from the single pre-loop baseline (#1927).
  let environmentCause = isEnvironmentFailure(summary, baseline);
  if (environmentCause) {
    log('check', `every failing checker also fails on base — rework cause=${classifyBaseFailureCause(summary)}`);
  }

  // Serial re-run (#2301): a tests failure that passes alone is flaky; act on it (#2302).
  let flakeRerun: FlakeRerun | undefined;
  if (environmentCause) {
    const testsFail = summary.results.find((r) => r.checker === 'tests' && r.result === 'FAIL');
    if (testsFail) {
      flakeRerun = await rerunTestsChecker({ ...ctx, runCommand: runCommand ?? ctx.runCommand }, testsFail.details);
      log(
        'check',
        `flaky re-run: ${flakeRerun.verdict} (${flakeRerun.mode}, ${flakeRerun.tests.length} tests)` +
          (flakeRerun.reason ? ` — ${flakeRerun.reason}` : ''),
      );
      if (flakeRerun.verdict === 'passed') {
        summary = markTestsFlaky(summary, flakeRerun);
        summary = await appendEvidencePlanStep(summary, ctx, constitution, runEvidence);
        environmentCause = isEnvironmentFailure(summary, baseline);
        log(
          'check',
          `tests passed on serial re-run — flaky, treating tests as PASS${environmentCause ? '' : '; continuing'}`,
        );
      }
    }
  }

  // Environment cause (#1928): the lane cannot fix a broken base, so skip rework and the
  // held check; the caller releases the issue and pauses the lane.
  if (environmentCause && baseline) {
    const environment: EnvironmentFailure = {
      baseSha: baseline.baseSha,
      failingChecks: failingCheckerNames(summary),
      cause: classifyBaseFailureCause(summary),
      logPaths: environmentLogPaths(summary, checkBaseDir),
    };
    log(
      'check',
      `environment failure on base ${baseline.baseSha.slice(0, 8)} (${environment.failingChecks.join(', ')}) — skipping rework`,
    );
    logFailures(summary);
    return {
      passed: false,
      summary,
      reworkRounds: 0,
      failureSignature: failureSignature(summary),
      baseline,
      environment,
      ...(flakeRerun ? { flakeRerun } : {}),
    };
  }

  const baseFailing = baseFailingCheckers(baseline);
  if (baseFailing.size > 0) log('check', `dropping base-failing checkers from rework: ${[...baseFailing].join(', ')}`);

  const triaged = await infraTriage(
    summary,
    (s) => excludeBaseFailing(s, baseFailing),
    async () => {
      ctx.outputLogDir = checkTriageDir;
      const rerun = await (runCheckers ?? runAllCheckers)(ctx, router, constitution, checkTimeoutSeconds);
      return appendEvidencePlanStep(rerun, ctx, constitution, runEvidence);
    },
    log,
    logFailures,
  );
  summary = triaged.summary;
  if (triaged.infra !== undefined) {
    return {
      passed: false,
      summary,
      reworkRounds: 0,
      failureSignature: failureSignature(summary),
      infra: triaged.infra,
      ...(baseline ? { baseline } : {}),
    };
  }

  // Cross-run stuck (#740): round one already reproduces the exact failure a
  // prior run parked on. Skip the rework loop entirely rather than re-burning
  // a full budget against a root cause nothing has fixed since — a watchdog
  // relaunching a dead session every ~10 minutes would otherwise walk straight
  // back into the same 3 rework rounds indefinitely.
  if (
    summary.failures > 0 &&
    priorFailureSignature !== undefined &&
    (stuckSignature(summary, baseFailing) === priorFailureSignature ||
      failureSignature(summary) === priorFailureSignature)
  ) {
    const failingChecks = failingCheckerNames(summary);
    log(
      'held',
      `issue already parked on this exact failure signature in a prior run (${failingChecks.join(', ')}) — holding for a human decision instead of burning another rework budget`,
      { rework: { round: 0, failingChecks, cause: 'factory-fault', stuck: true, ...testFailureEvidence(summary) } },
    );
    return {
      passed: false,
      summary,
      reworkRounds: 0,
      stuck: true,
      crossRunStuck: true,
      failureSignature: priorFailureSignature,
      ...(baseline ? { baseline } : {}),
    };
  }

  let stuck = false;
  let noProgressStreak = 0;

  while (summary.failures > 0 && reworkRounds < maxRounds) {
    const target = excludeBaseFailing(summary, baseFailing);
    if (target.failures === 0) {
      log('check', `only base-failing checkers remain (${failingCheckerNames(summary).join(', ')}) — stopping rework`);
      break;
    }
    reworkRounds++;
    const signatureBefore = stuckSignature(summary, baseFailing);
    const failingChecks = failingCheckerNames(summary);
    const evidence = testFailureEvidence(summary);

    const steering = drainSteering?.();

    const verifyInstruction = await affectedVerifyInstruction(await selectAffected(reworkRounds), ctx);
    const { failovers, modelCompleted, failureReason, budgetStopped } = await reworkWorker({
      issue,
      worktree,
      specPath,
      summary: target,
      constitution,
      router,
      log,
      buildTimeoutSeconds,
      sandbox,
      steering,
      appPort,
      appBaseUrl,
      onPgid,
      budgetGuard,
      reworkRoute,
      reworkModel,
      runId,
      onWorkerResult: opts.onWorkerResult,
      verifyInstruction,
    });

    const cause: ReworkCause = classifyReworkCause({
      steering,
      failovers,
      failureReason,
      config: summary.results.some(isConfigCheckerOutput),
    });
    log(
      'rework',
      `round ${reworkRounds}/${maxRounds}: ${summary.failures} failing (${failingChecks.join(', ')}) — cause=${cause}`,
      { rework: { round: reworkRounds, failingChecks, cause, ...evidence } },
    );
    if (budgetStopped) break;
    if (steering && steering.messages.length > 0) {
      log('steering_applied', describeSteering(steering));
    }

    await markBuildFilesIntentToAdd(worktree, log);
    probe = await probeWorktree(worktree);
    ctx.probe = probe;
    ctx.outputLogDir = roundLogDir(reworkRounds);
    ctx.affectedTests = await selectAffected(reworkRounds);
    log('check', hermeticGitNote);
    summary = await (runCheckers ?? runAllCheckers)(ctx, router, constitution, checkTimeoutSeconds);
    summary = await fullTestsBeforeShip(summary, ctx, reworkRounds, log);
    ctx.affectedTests = undefined;
    summary = await appendEvidencePlanStep(summary, ctx, constitution, runEvidence);
    log('check', `Rework round ${reworkRounds}: ${summary.failures} failures remaining`);
    // When no model ran this round (modelCompleted === false), an unchanged failure
    // signature is not evidence of a stuck worker — leave the streak untouched
    // (neither advanced nor reset) rather than treat a provider outage as no-progress (#642).
    if (modelCompleted) {
      if (summary.failures > 0 && stuckSignature(summary, baseFailing) === signatureBefore) {
        noProgressStreak++;
      } else {
        noProgressStreak = 0;
      }
    }

    if (noProgressStreak >= STUCK_THRESHOLD) {
      stuck = true;
      log(
        'stuck',
        `lane stuck: identical failures (${failingCheckerNames(summary).join(', ')}) across ${STUCK_THRESHOLD} consecutive rework rounds — escalating early`,
        {
          rework: {
            round: reworkRounds,
            failingChecks: failingCheckerNames(summary),
            cause: 'factory-fault',
            stuck: true,
            ...testFailureEvidence(summary),
          },
        },
      );
      break;
    }
  }

  for (const s of summary.results.filter((r) => r.result === 'SKIP')) {
    log('check', `SKIPPED: ${s.checker} — ${s.details}`);
  }

  logFailures(summary);

  for (const p of summary.results.filter((r) => r.result === 'PASS' && r.findings?.length)) {
    log('check', `FINDINGS: ${p.checker}\n${renderCheckerFindings(p.findings ?? []).join('\n')}`);
  }

  if (summary.failures > 0) {
    const showstoppers = remainingShowstoppers(summary);
    log(
      'fail',
      `${summary.failures} check failures after ${reworkRounds} rework rounds — parking` +
        (showstoppers.length > 0 ? `\nremaining showstoppers:\n${showstoppers.map((x) => `- ${x}`).join('\n')}` : ''),
    );
  } else log('check', describeCheckOutcome(summary));

  const finalHeadedSignals = reworkRounds > 0 ? detectHeadedModeSignals(probe) : headedSignals;
  if (finalHeadedSignals.length > 0) {
    summary = { ...summary, warnings: finalHeadedSignals };
  }

  return {
    passed: summary.failures === 0,
    summary,
    reworkRounds,
    stuck,
    failureSignature: summary.failures > 0 ? stuckSignature(summary, baseFailing) : undefined,
    ...(baseline ? { baseline } : {}),
    ...(flakeRerun ? { flakeRerun } : {}),
  };
}

export interface ReworkWorkerOptions {
  issue: number;
  worktree: string;
  specPath: string;
  summary: CheckSummary;
  constitution: Constitution | null;
  router: ModelRouter;
  log: LogFn;
  buildTimeoutSeconds?: number;
  sandbox?: SandboxPolicy;
  steering?: ConsumedSteering;
  appPort?: number;
  appBaseUrl?: string;
  onPgid?: (pgid: number) => void;
  budgetGuard?: BudgetGuard;
  reworkRoute?: BuildRoutePin;
  reworkModel?: string;
  runId?: string;
  /** Called with each rework worker's router result, e.g. to keep it as a run log (#3274). */
  onWorkerResult?: (result: RouterResult) => Promise<void>;
  extraInstructions?: string;
  /** Replaces rework instruction 3 (#3260); undefined keeps the default text. */
  verifyInstruction?: string;
}

// Rework reads the failing code before changing it, staying scoped to the failures (#3372, T13).
export const REWORK_READ_RULE =
  'Before changing anything, read the code at each failing location (the file and line in the failure, or the failing test and the code it exercises).';

export async function reworkWorker(opts: ReworkWorkerOptions): Promise<{
  failovers: { model: string; reason: FailoverReason; detail?: string }[];
  /** False when router.run threw — no model produced output for this round (#642). */
  modelCompleted: boolean;
  failureReason?: FailoverReason;
  budgetStopped?: boolean;
}> {
  const {
    issue,
    worktree,
    specPath,
    summary,
    constitution,
    router,
    log,
    buildTimeoutSeconds,
    sandbox,
    steering,
    appPort,
    appBaseUrl,
    onPgid,
    budgetGuard,
    reworkRoute = 'claude',
    reworkModel,
    runId,
  } = opts;
  const constitutionCtx = buildConstitutionContext(constitution);
  const failures = summary.results.filter((r) => r.result === 'FAIL');
  const failureDetails = failures.map((f) => `### ${f.checker}\n${f.details}`).join('\n\n');

  let prompt = `You are a WORKER agent in the rework loop of a software factory.
Your previous work on issue #${issue} failed independent verification. Fix the
specific failures listed below.

WORKTREE: ${worktree} (you are here)
SPEC: ${specPath}

${constitutionCtx}

## Check Failures (from independent verification agents)
${failureDetails}

Each failure above is a bounded summary. When it ends with \`full output: <path>\`,
read that file first — it holds the command's complete stdout and stderr.

## Instructions
1. ${REWORK_READ_RULE} Then make one focused repair pass. Change only files necessary to address the listed failures.
2. Do not re-plan, refactor unrelated code, or investigate outside these failures.
3. ${opts.verifyInstruction ?? 'Re-run only the failing command or the smallest relevant verification command.'}
4. Commit the repair with a clear message.${opts.extraInstructions ? `\n5. ${opts.extraInstructions}` : ''}

Do not push, do not open a PR. Just fix and commit. The checker will re-verify.`;

  prompt = applySteering(prompt, steering);
  let reworkResult: RouterResult | null = null;
  let failureReason: FailoverReason | undefined;
  let attempts: RouterResult['attempts'] = [];

  const { route, rerouted, modelOverride } = resolveReworkRoute(router, reworkRoute, reworkModel);
  if (rerouted) {
    log('model-override', `rework route ${reworkRoute} has no runnable model on this machine, rerouting to ${route}`);
  }

  try {
    reworkResult = await router.run(`build_${route}`, prompt, {
      worktree,
      timeoutSeconds: buildTimeoutSeconds ?? 7200,
      sandbox,
      onSandboxEvent: (type, detail) => log(type, detail),
      onLog: (msg) => log('router', msg),
      env: laneEnv(appPort, process.env, appBaseUrl, worktree, runId),
      onPgid,
      retryCause: 'checker',
      modelOverride,
      budgetGuard,
    });
    await opts.onWorkerResult?.(reworkResult);
    attempts = reworkResult.attempts;
  } catch (err) {
    if (isBudgetStopError(err)) return { failovers: [], modelCompleted: false, budgetStopped: true };
    // ModelRouter.run only throws once every eligible model is exhausted, and the
    // error carries the reason + attempts. Swallowing it made a provider outage
    // look like a factory fault (#642).
    const routerFailure = routerFailureOf(err);
    failureReason = routerFailure?.reason;
    attempts = routerFailure?.attempts ?? [];
    const attemptSummary =
      attempts.map((a) => `${a.model}(${a.reason ?? 'ok'}${a.detail ? `: ${a.detail}` : ''})`).join(', ') || 'none';
    log(
      'rework_model_failed',
      `rework worker never ran: router exhausted every eligible model (${failureReason ?? 'unknown'}) — attempts: ${attemptSummary}`,
      failureReason ? { failoverReason: failureReason } : undefined,
    );
  }

  const failovers = failoversFrom(attempts);
  for (const f of failovers) {
    log('failover', `${f.model} failed (${f.reason})${f.detail ? `: ${f.detail}` : ''} — failed over`, {
      failoverReason: f.reason,
    });
  }

  return {
    failovers,
    modelCompleted: reworkResult !== null,
    ...(failureReason ? { failureReason } : {}),
  };
}
