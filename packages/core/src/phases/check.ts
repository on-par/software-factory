// src/phases/check.ts — CHECK phase: independent checkers verify output, rework loop

import { type LifecycleBus, withLifecycle } from '../bus/index.js';
import { type CheckerContext, probeWorktree, runAllCheckers, type WorktreeProbe } from '../checkers/index.js';
import { buildConstitutionContext } from '../constitutions/index.js';
import { laneEnv } from '../environment/index.js';
import type { EventKind } from '../events/kinds.js';
import type { ModelRouter, RouterResult } from '../router/index.js';
import { failoversFrom } from '../router/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { applySteering, type ConsumedSteering, describeSteering } from '../steering/index.js';
import type { CheckSummary, Constitution, FailoverReason, ReworkCause, ReworkInfo } from '../types/index.js';

type LogFn = (type: EventKind, msg: string, extra?: { failoverReason?: FailoverReason; rework?: ReworkInfo }) => void;

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
}

const MAX_REWORK_ROUNDS = 3;

/** Consecutive no-progress rework rounds before the lane is declared stuck. */
const STUCK_THRESHOLD = 2;

/** Provider/CI-level reasons that point away from a factory fault. */
const EXTERNAL_REASONS = new Set<FailoverReason>(['rate_limit', 'usage_cap', 'timeout', 'unavailable', 'local_auth']);

/** Deterministic signature of the failing checks: name + volatility-stripped detail. */
function failureSignature(summary: CheckSummary): string {
  return summary.results
    .filter((r) => r.result === 'FAIL')
    .map((r) => `${r.checker}:${normalizeDetail(r.details)}`)
    .sort()
    .join('|');
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
  const failingTests = details
    .split(/\r?\n/)
    .flatMap((line) => line.match(/(?:\bFAIL|[×✕●])\s+(.+)/)?.[1] ?? line.match(/\bnot ok \d+\s*-\s*(.+)/i)?.[1] ?? [])
    .map((identifier) => identifier.trim())
    .filter((identifier) => identifier !== '')
    .slice(0, MAX_FAILING_TESTS);

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

export async function checkPhase(opts: Parameters<typeof checkPhaseImpl>[0]): Promise<CheckPhaseResult> {
  return withLifecycle(
    { bus: opts.bus, phase: 'check', laneId: opts.laneId, issueId: opts.issue, worktreePath: opts.worktree },
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
  /** Worker route that completed BUILD; direct callers retain Claude rework by default. */
  reworkRoute?: 'codex' | 'claude' | 'opencode';
  /** Worker model that completed BUILD, retained as the compatible rework override. */
  reworkModel?: string;
  /** Lane id stamped onto emitted lifecycle events; defaults to `issue-<issue>` (#591). */
  laneId?: string;
  /** Lifecycle bus to emit onto; defaults to the process-wide `lifecycleBus` (#591). */
  bus?: LifecycleBus;
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
    reworkRoute,
    reworkModel,
  } = opts;

  let probe = await probeWorktree(worktree);
  const ctx: CheckerContext = { worktree, specPath, env: laneEnv(appPort, process.env, appBaseUrl), onPgid, probe };

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

  let summary = await runAllCheckers(ctx, router, constitution, checkTimeoutSeconds);
  let reworkRounds = 0;
  const maxRounds = autoRework ? Math.min(maxReworkRounds, MAX_REWORK_ROUNDS) : 0;

  if (summary.results.some((result) => result.checker === 'worker_output' && result.result === 'FAIL')) {
    const signature = failureSignature(summary);
    log('fail', 'worker produced no implementation diff — parking before rework');
    return { passed: false, summary, reworkRounds: 0, failureSignature: signature };
  }

  // Cross-run stuck (#740): round one already reproduces the exact failure a
  // prior run parked on. Skip the rework loop entirely rather than re-burning
  // a full budget against a root cause nothing has fixed since — a watchdog
  // relaunching a dead session every ~10 minutes would otherwise walk straight
  // back into the same 3 rework rounds indefinitely.
  if (
    summary.failures > 0 &&
    priorFailureSignature !== undefined &&
    failureSignature(summary) === priorFailureSignature
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
    };
  }

  let stuck = false;
  let noProgressStreak = 0;

  while (summary.failures > 0 && reworkRounds < maxRounds) {
    reworkRounds++;
    const signatureBefore = failureSignature(summary);
    const failingChecks = failingCheckerNames(summary);
    const evidence = testFailureEvidence(summary);

    const steering = drainSteering?.();

    const { failovers, modelCompleted, failureReason } = await reworkWorker({
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
      reworkRoute,
      reworkModel,
    });

    const cause = classifyReworkCause({ steering, failovers, failureReason });
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
    summary = await runAllCheckers(ctx, router, constitution, checkTimeoutSeconds);
    log('check', `Rework round ${reworkRounds}: ${summary.failures} failures remaining`);
    // When no model ran this round (modelCompleted === false), an unchanged failure
    // signature is not evidence of a stuck worker — leave the streak untouched
    // (neither advanced nor reset) rather than treat a provider outage as no-progress (#642).
    if (modelCompleted) {
      if (summary.failures > 0 && failureSignature(summary) === signatureBefore) {
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

  // Each failing checker is logged individually, the same way SKIPs are: the parked
  // outcome only carries an aggregate count, so without this the checker/details pairs
  // that name WHY a run parked are never surfaced to the operator (#675).
  for (const f of summary.results.filter((r) => r.result === 'FAIL')) {
    log('check', `FAILED: ${f.checker} — ${f.details}`);
  }

  if (summary.failures > 0) {
    log('fail', `${summary.failures} check failures after ${reworkRounds} rework rounds — parking`);
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
    failureSignature: summary.failures > 0 ? failureSignature(summary) : undefined,
  };
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
      env: laneEnv(appPort, process.env, appBaseUrl),
      onPgid,
      retryCause: 'checker',
      modelOverride: reworkModel,
    });
    attempts = reworkResult.attempts;
  } catch (err) {
    // ModelRouter.run only throws once every eligible model is exhausted, and the
    // error carries the reason + attempts. Swallowing it made a provider outage
    // look like a factory fault (#642).
    failureReason = (err as { reason?: FailoverReason }).reason;
    attempts = (err as { attempts?: RouterResult['attempts'] }).attempts ?? [];
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
