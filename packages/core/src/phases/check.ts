// src/phases/check.ts — CHECK phase: independent checkers verify output, rework loop

import { join } from 'node:path';

import { type LifecycleBus, withLifecycle } from '../bus/index.js';
import { BaselineCache } from '../checkers/baseline-cache.js';
import { type BaselineReport, extractFailingTestNames, runBaselineCheckers } from '../checkers/baseline.js';
import {
  type CheckerContext,
  probeWorktree,
  renderCheckerFindings,
  runAllCheckers,
  type WorktreeProbe,
} from '../checkers/index.js';
import { buildConstitutionContext } from '../constitutions/index.js';
import { laneEnv } from '../environment/index.js';
import type { EventKind } from '../events/kinds.js';
import { routerFailureOf } from '../router/executor-error.js';
import type { ModelRouter, RouterResult } from '../router/index.js';
import { failoversFrom } from '../router/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { applySteering, type ConsumedSteering, describeSteering } from '../steering/index.js';
import type {
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
  /** Deterministic signature of the final failing checks, for the caller to persist
   *  via ReworkHistory so a future run can detect a repeat. Present whenever the
   *  phase ends with `summary.failures > 0`; absent when it passes clean. */
  failureSignature?: string;
  /** Round-1 failing checkers re-run on diffBase (#1925); absent when round 1 passed, worker_output failed, or no diffBase. */
  baseline?: BaselineReport;
  /** Set when every round-1 failing checker also fails on the base SHA (#1928): no rework
   *  ran (`reworkRounds` is 0) and the caller releases the issue instead of parking it. */
  environment?: EnvironmentFailure;
}

export const MAX_REWORK_ROUNDS = 3;

/** Checker name of the model-judged showstopper review (#2236); signed by file:line, not prose (#2238). */
export const LENS_REVIEW_CHECKER = 'lens_review';

/** Consecutive no-progress rework rounds before the lane is declared stuck. */
const STUCK_THRESHOLD = 2;

/** Provider/CI-level reasons that point away from a factory fault. */
const EXTERNAL_REASONS = new Set<FailoverReason>(['rate_limit', 'usage_cap', 'timeout', 'unavailable', 'local_auth']);

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

/** Matches one lens_review showstopper line: optional bullet, `file:line`, then a dash separator (#2238). */
const SHOWSTOPPER_LINE = /^\s*(?:[-*•]\s+)?(\S.*?:\d+)\s+[—–-]\s+\S/;

/** Sorted, de-duplicated `file:line` refs of the showstoppers in lens_review FAIL details. */
export function lensShowstopperRefs(details: string): string[] {
  const refs = new Set<string>();
  for (const line of details.split('\n')) {
    const m = SHOWSTOPPER_LINE.exec(line);
    if (m) refs.add(m[1].trim());
  }
  return [...refs].sort();
}

/** The showstopper lines of a lens_review FAIL in `summary`, for park messages (#2238); empty when none. */
export function remainingShowstoppers(summary: CheckSummary): string[] {
  const lens = summary.results.find((r) => r.checker === LENS_REVIEW_CHECKER && r.result === 'FAIL');
  if (!lens) return [];
  return lens.details
    .split('\n')
    .filter((line) => SHOWSTOPPER_LINE.test(line))
    .map((line) => line.trim());
}

/** Full-output log files named by round-1 FAIL results, then the base-run log dir; deduped, first-seen order. */
export function environmentLogPaths(summary: CheckSummary, baseLogDir: string | undefined): string[] {
  const paths: string[] = [];
  for (const r of summary.results.filter((x) => x.result === 'FAIL')) {
    for (const m of r.details.matchAll(/^full output: (.+)$/gm)) paths.push(m[1]);
  }
  if (baseLogDir !== undefined) paths.push(baseLogDir);
  return [...new Set(paths)];
}

export function renderEnvironmentReleaseComment(failure: EnvironmentFailure): string {
  return [
    '### Factory: CHECK failure caused by the base, not this issue',
    '',
    `Every failing checker also fails on base \`${failure.baseSha}\`, so no rework was run. This issue was released back to \`factory:queued\` and the lane is paused until the base is fixed.`,
    '',
    'Failing checkers:',
    ...failure.failingChecks.map((c) => `- \`${c}\``),
    '',
    `Base SHA: \`${failure.baseSha}\``,
    '',
    ...(failure.logPaths.length > 0
      ? ['Logs:', ...failure.logPaths.map((p) => `- \`${p}\``)]
      : ['No log paths were recorded (logsDir not set).']),
    '',
  ].join('\n');
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

/** Human-readable e2e signal ("playwright.config.ts", "package.json script 'e2e'"), or null when the worktree shows no live-app testing. */
function detectLiveAppSignal(probe: WorktreeProbe): string | null {
  if (probe.playwrightConfigFiles.length > 0) return probe.playwrightConfigFiles[0];

  for (const [name, script] of Object.entries(probe.scripts)) {
    if (script.includes('playwright') || name === 'e2e' || name.includes('e2e')) {
      return `package.json script '${name}'`;
    }
  }

  return null;
}

/** Human-readable headed-mode signals ("playwright.config.ts forces headless: false",
 *  "package.json script 'e2e' passes --headed"), empty when nothing forces a headed browser. */
function detectHeadedModeSignals(probe: WorktreeProbe): string[] {
  const signals: string[] = [];

  for (const f of probe.playwrightConfigFiles) {
    const content = probe.playwrightConfigContents[f] ?? '';
    if (/headless\s*:\s*false/.test(content)) {
      signals.push(`${f} forces headless: false`);
    }
  }

  for (const [name, script] of Object.entries(probe.scripts)) {
    if (/(^|\s)--headed\b/.test(script)) {
      signals.push(`package.json script '${name}' passes --headed`);
    } else if (/(^|\s)--ui\b/.test(script)) {
      signals.push(`package.json script '${name}' passes --ui`);
    }
    if (/\bcypress\s+open\b/.test(script)) {
      signals.push(`package.json script '${name}' runs 'cypress open' (interactive UI runner)`);
    }
  }

  return signals;
}

function classifyReworkCause(opts: {
  steering?: ConsumedSteering;
  failovers: { reason: FailoverReason }[];
  /** Reason from a router error when the call threw before any model produced output (#642). */
  failureReason?: FailoverReason;
}): ReworkCause {
  if (opts.steering && opts.steering.messages.length > 0) return 'direction-change';
  if (opts.failovers.some((f) => EXTERNAL_REASONS.has(f.reason))) return 'external';
  if (opts.failureReason !== undefined && EXTERNAL_REASONS.has(opts.failureReason)) return 'external';
  return 'factory-fault';
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
  sandbox?: SandboxPolicy;
  drainSteering?: () => ConsumedSteering;
  appPort?: number;
  /** Stable lane URL from the factory proxy (e.g. http://<lane>.factory.localhost), when running. */
  appBaseUrl?: string;
  onPgid?: (pgid: number) => void;
  /** Failure signature this issue parked/got stuck on in a prior run (ReworkHistory,
   *  #740). When round one's signature matches, the rework loop is skipped entirely
   *  instead of re-burning a full budget against an unfixed root cause. */
  priorFailureSignature?: string;
  /** Fallback diff base for workerOutputChecker and designSmellsChecker in checkouts
   *  with no remote base ref (#1211, #1212). For localOnly runs this is the run-start
   *  HEAD captured once in runIssue before PLAN (#1210); otherwise it is buildPhase's
   *  pre-worker HEAD. */
  diffBase?: string;
  /** Worker route that completed BUILD; direct callers retain Claude rework by default. */
  reworkRoute?: 'codex' | 'claude' | 'opencode';
  /** Worker model that completed BUILD, retained as the compatible rework override. */
  reworkModel?: string;
  /** Lane id stamped onto emitted lifecycle events; defaults to `issue-<issue>` (#591). */
  laneId?: string;
  /** Per-run id minted by runIssue; becomes SharedCompilationId=factory-<runId> for .NET lanes (#1910). */
  runId?: string;
  /** Lifecycle bus to emit onto; defaults to the process-wide `lifecycleBus` (#591). */
  bus?: LifecycleBus;
  /** Heartbeat hook (#1326), forwarded to `CheckerContext.onActivity` — bumps the
   *  persisted run-phase snapshot's `lastActivityAt` around every checker. */
  onActivity?: () => void | Promise<void>;
  /** Factory logs dir (`.factory/state/logs`). When set, failing checker commands write
   *  their full output to `<logsDir>/issue-<n>/check-r<round>/` and FAIL details link it. */
  logsDir?: string;
  /** state/baseline-cache.json (#1926); when set, baseline results are cached per base SHA + laneEnv hash. */
  baselineCachePath?: string;
  /** Injection seam for tests; defaults to runBaselineCheckers (#1925). */
  runBaseline?: typeof runBaselineCheckers;
  /** Injection seam for tests; defaults to runAllCheckers (#2238). */
  runCheckers?: typeof runAllCheckers;
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
    sandbox,
    drainSteering,
    appPort,
    appBaseUrl,
    onPgid,
    priorFailureSignature,
    diffBase,
    reworkRoute,
    reworkModel,
    runId,
    onActivity,
    logsDir,
    baselineCachePath,
    runBaseline,
    runCheckers,
  } = opts;
  const roundLogDir = (round: number): string | undefined =>
    logsDir === undefined ? undefined : join(logsDir, `issue-${issue}`, `check-r${round}`);
  const checkBaseDir = logsDir === undefined ? undefined : join(logsDir, `issue-${issue}`, 'check-base');

  // Each failing checker is logged individually, the same way SKIPs are: the parked
  // outcome only carries an aggregate count, so without this the checker/details pairs
  // that name WHY a run parked are never surfaced to the operator (#675).
  const logFailures = (s: CheckSummary): void => {
    for (const f of s.results.filter((r) => r.result === 'FAIL')) {
      log(
        'check',
        f.findings?.length
          ? `FAILED: ${f.checker} — ${f.details}\n${renderCheckerFindings(f.findings).join('\n')}`
          : `FAILED: ${f.checker} — ${f.details}`,
      );
    }
  };

  let probe = await probeWorktree(worktree);
  const ctx: CheckerContext = {
    worktree,
    specPath,
    diffBase,
    env: laneEnv(appPort, process.env, appBaseUrl, worktree, runId),
    onPgid,
    probe,
    log,
    onActivity,
    outputLogDir: roundLogDir(0),
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

  let summary = await (runCheckers ?? runAllCheckers)(ctx, router, constitution, checkTimeoutSeconds);
  let reworkRounds = 0;
  const maxRounds = autoRework ? Math.min(maxReworkRounds, MAX_REWORK_ROUNDS) : 0;

  if (summary.results.some((result) => result.checker === 'worker_output' && result.result === 'FAIL')) {
    const signature = failureSignature(summary);
    log('fail', 'worker produced no implementation diff — parking before rework');
    return { passed: false, summary, reworkRounds: 0, failureSignature: signature };
  }

  let baseline: BaselineReport | undefined;
  if (summary.failures > 0) {
    if (diffBase === undefined) {
      log('check', 'baseline skipped: no base SHA for this run');
    } else {
      baseline = await (runBaseline ?? runBaselineCheckers)({
        baseSha: diffBase,
        laneWorktree: worktree,
        failing: summary.results,
        ctx: {
          ...ctx,
          outputLogDir: checkBaseDir,
        },
        router,
        constitution,
        customCheckerTimeoutSeconds: checkTimeoutSeconds,
        cache: baselineCachePath === undefined ? undefined : new BaselineCache(baselineCachePath),
      }).catch((e: any) => ({ baseSha: diffBase, checkers: [], error: String(e?.message ?? e).slice(0, 300) }));
      log('check', describeBaseline(baseline));
    }
  }

  // Decided before the rework loop from the single pre-loop baseline (#1927).
  const environmentCause = isEnvironmentFailure(summary, baseline);
  if (environmentCause) log('check', 'every failing checker also fails on base — rework cause=environment');

  // Environment cause (#1928): the lane cannot fix a broken base, so skip rework and the
  // held check; the caller releases the issue and pauses the lane.
  if (environmentCause && baseline) {
    const environment: EnvironmentFailure = {
      baseSha: baseline.baseSha,
      failingChecks: failingCheckerNames(summary),
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
    };
  }

  const baseFailing = baseFailingCheckers(baseline);
  if (baseFailing.size > 0) log('check', `dropping base-failing checkers from rework: ${[...baseFailing].join(', ')}`);

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

    const { failovers, modelCompleted, failureReason } = await reworkWorker({
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
      reworkRoute,
      reworkModel,
      runId,
    });

    const cause: ReworkCause = classifyReworkCause({ steering, failovers, failureReason });
    log(
      'rework',
      `round ${reworkRounds}/${maxRounds}: ${summary.failures} failing (${failingChecks.join(', ')}) — cause=${cause}`,
      { rework: { round: reworkRounds, failingChecks, cause, ...evidence } },
    );
    if (steering && steering.messages.length > 0) {
      log('steering_applied', describeSteering(steering));
    }

    probe = await probeWorktree(worktree);
    ctx.probe = probe;
    ctx.outputLogDir = roundLogDir(reworkRounds);
    summary = await (runCheckers ?? runAllCheckers)(ctx, router, constitution, checkTimeoutSeconds);
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
  } else {
    log('check', summary.skips > 0 ? `All checkers passed (${summary.skips} skipped)` : 'All checkers passed');
  }

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
  };
}

/** One-line summary of the baseline comparison for the CHECK log. */
function describeBaseline(report: BaselineReport): string {
  const parts = report.checkers.map((c) => {
    if (c.verdict === 'fails-on-base') {
      const counts =
        c.sharedFailingTests && c.newFailingTests
          ? ` (${c.sharedFailingTests.length} shared, ${c.newFailingTests.length} new failing tests)`
          : '';
      return `${c.checker} also fails on base${counts}${c.cached ? ' (cached)' : ''}`;
    }
    if (c.verdict === 'clean-on-base') return `${c.checker} clean on base${c.cached ? ' (cached)' : ''}`;
    return `${c.checker} not run on base (${c.reason ?? 'unknown'})`;
  });
  const body = parts.length > 0 ? parts.join('; ') : 'no checkers compared';
  return `baseline at ${report.baseSha.slice(0, 8)}: ${body}${report.error ? ` — error: ${report.error}` : ''}`;
}

interface ReworkWorkerOptions {
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
  reworkRoute?: 'codex' | 'claude' | 'opencode';
  reworkModel?: string;
  runId?: string;
}

async function reworkWorker(opts: ReworkWorkerOptions): Promise<{
  failovers: { model: string; reason: FailoverReason; detail?: string }[];
  /** False when router.run threw — no model produced output for this round (#642). */
  modelCompleted: boolean;
  failureReason?: FailoverReason;
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
1. Make one focused repair pass. Change only files necessary to address the listed failures.
2. Do not re-plan, refactor unrelated code, or investigate outside these failures.
3. Re-run only the failing command or the smallest relevant verification command.
4. Commit the repair with a clear message.

Do not push, do not open a PR. Just fix and commit. The checker will re-verify.`;

  prompt = applySteering(prompt, steering);

  let reworkResult: RouterResult | null = null;
  let failureReason: FailoverReason | undefined;
  let attempts: RouterResult['attempts'] = [];

  try {
    reworkResult = await router.run(`build_${reworkRoute}`, prompt, {
      worktree,
      timeoutSeconds: buildTimeoutSeconds ?? 7200,
      sandbox,
      onSandboxEvent: (type, detail) => log(type, detail),
      onLog: (msg) => log('router', msg),
      env: laneEnv(appPort, process.env, appBaseUrl, worktree, runId),
      onPgid,
      retryCause: 'checker',
      modelOverride: reworkModel,
    });
    attempts = reworkResult.attempts;
  } catch (err) {
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
