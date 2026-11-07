// src/checkers/base-health.ts — pre-PLAN health check of origin/main, cached per base SHA (#2339).
// #3287: a cached non-timeout FAIL whose SHA GitHub CI calls green is re-run once, fresh; a fresh
// FAIL is `confirmedLocally` (logged as base_divergence) and never re-run for that SHA in-process.
// #3540: that cached FAIL is also deleted from the cache file and logged as baseline-cache-invalidated.
// A FAIL that never reached a verdict (timeout, environment exit 78, missing command, no exit code) is
// `inconclusive`, never red: the caller holds instead of entering PLAN. Every result carries bounded evidence.

import type { EventKind } from '../events/kinds.js';
import type { ModelRouter } from '../router/index.js';
import type { Constitution } from '../types/index.js';
import { runCommand } from '../utils/command-runner.js';
import { GIT_COMMAND_TIMEOUT_MS } from '../utils/git-exec.js';
import type { RequiredChecksVerdict } from '../utils/required-checks.js';

// The strict CI lookup rides with base health on the internal surface (#3186).
export { fetchRequiredChecksVerdict, type RequiredChecksVerdict } from '../utils/required-checks.js';
import {
  type BaselineCheckerComparison,
  type BaselineDeps,
  type BaselineReport,
  runBaselineCheckers,
} from './baseline.js';
import { BaselineCache, hashBaselineCheckerConfig, hashBaselineEnv } from './baseline-cache.js';
import { redactSecrets } from '../filing/redact.js';
import { outputTail } from './command-output.js';
import { describeInconclusive, type InconclusiveCause, inconclusiveCause } from './inconclusive.js';
import { runAllCheckers } from './index.js';
import type { CheckerOutput } from '../types/index.js';

/** Deterministic checkers that never call a model; the only ones run on base before PLAN. */
export const BASE_HEALTH_CHECKERS: readonly string[] = ['compile', 'lint', 'tests'];

/** Chars of the fresh checker output kept in a base_divergence event (#3287). */
export const BASE_DIVERGENCE_TAIL_CHARS = 500;

/** One base checker FAIL, as quoted in the result and the released message. */
export interface BaseHealthEvidence {
  checker: string;
  /** Set when the FAIL never reached a verdict. A timed-out compile also carries 'timeout' while it stays red on
   *  its CI-gated path (#3186); every other entry with a cause is inconclusive. */
  cause?: InconclusiveCause;
  /** The command, passed through redactSecrets. */
  command?: string;
  /** The command's exit code; absent when it had none (timeout kill, signal, spawn failure). */
  exitCode?: number;
  timeoutSeconds?: number;
  /** Tail of the checker's FAIL details, at most BASE_DIVERGENCE_TAIL_CHARS (+1 for the ellipsis), passed through redactSecrets. */
  tail: string;
}

export interface BaseHealthResult {
  /** red = at least one BASE_HEALTH_CHECKERS checker FAILs on base; inconclusive = a base check could not run
   *  (timeout, environment, setup) and nothing is red (fail closed: hold); skipped = could not decide (fail open). */
  kind: 'green' | 'red' | 'inconclusive' | 'skipped';
  baseSha?: string;
  /** Checkers that fail on base; empty unless red. */
  failingChecks: string[];
  /** True when any base result came from the baseline cache or the in-process memo. */
  cached: boolean;
  reason?: string;
  /** Red only because a compile timeout awaits green required CI (#3186). */
  awaitingCi?: boolean;
  /** Red because a fresh local re-run confirmed a cached FAIL that GitHub CI calls green (#3287). */
  confirmedLocally?: boolean;
  /** Red or inconclusive: the base FAILs behind the verdict. */
  evidence?: BaseHealthEvidence[];
}

export interface BaseHealthOptions {
  /** Remote-tracking ref to test (#3764); default origin/main. */
  baseRef?: string;
  /** Lane worktree; git runs here, its files are never changed. */
  worktree: string;
  constitution: Constitution | null;
  /** Forwarded only because runBaselineCheckers requires it; never called for these checkers. */
  router: ModelRouter;
  /** The lane's laneEnv — the same env-hash source as CHECK's baseline. */
  env: Record<string, string>;
  /** state/baseline-cache.json; undefined = no file cache. */
  cachePath?: string;
  /** check.baselineCacheTtlHours (#3540); undefined = 24. */
  cacheTtlHours?: number;
  /** Custom-checker timeout in seconds (`request.timeouts.check`). */
  timeoutSeconds?: number;
  /** Tests checker timeout in seconds (`request.timeouts.tests`, #3095); undefined = the tests checker's 300s default. */
  testsTimeoutSeconds?: number;
  /** Compile checker timeout in seconds (`request.timeouts.compile`, #3185); undefined = the compile checker's 120s default. */
  compileTimeoutSeconds?: number;
  /** Strict GitHub CI lookup for a timed-out compile (#3186); absent = CI unknown. */
  requiredChecksVerdict?: (sha: string) => Promise<RequiredChecksVerdict>;
  log: (type: EventKind, msg: string) => void;
  deps?: {
    runCommand?: typeof runCommand;
    runBaseline?: typeof runBaselineCheckers;
    baselineDeps?: BaselineDeps;
    memo?: Map<string, Promise<BaselineReport>>;
    /** Memo keys whose cached-FAIL/green-CI divergence is already confirmed locally (#3287). */
    confirmed?: Set<string>;
  };
}

const defaultMemo = new Map<string, Promise<BaselineReport>>();
const defaultConfirmed = new Set<string>();

/** Why a base FAIL is inconclusive; a timed-out compile keeps its CI-gated path (#3186). */
function inconclusiveOf(c: BaselineCheckerComparison): InconclusiveCause | undefined {
  if (c.verdict !== 'fails-on-base' || (c.checker === 'compile' && c.baseTimedOut === true)) return undefined;
  return comparisonCause(c);
}

function comparisonCause(c: BaselineCheckerComparison): InconclusiveCause | undefined {
  return inconclusiveCause({
    timedOut: c.baseTimedOut === true,
    exitCode: c.baseCommand?.exitCode,
    checkerError: c.baseCheckerError === true,
  });
}

/** Bounded, redacted output tail: verify output can echo tokens (set -x, env dumps) into events and logs. */
function redactedTail(details: string): string {
  return outputTail(redactSecrets(details), BASE_DIVERGENCE_TAIL_CHARS);
}

function toEvidence(c: BaselineCheckerComparison): BaseHealthEvidence {
  const cmd = c.baseCommand;
  const cause = comparisonCause(c);
  return {
    checker: c.checker,
    ...(cause ? { cause } : {}),
    ...(cmd ? { command: redactSecrets(cmd.command) } : {}),
    ...(cmd && cmd.exitCode >= 0 ? { exitCode: cmd.exitCode } : {}),
    ...(cmd ? { timeoutSeconds: cmd.timeoutSeconds } : {}),
    tail: redactedTail(c.baseDetails ?? ''),
  };
}

/** One line per FAIL, e.g. tests: timeout after 300s — `bash scripts/verify.sh --no-e2e`: <tail>. */
function renderBaseHealthEvidence(e: BaseHealthEvidence): string {
  const what = e.cause
    ? describeInconclusive(e.cause, e.exitCode, e.timeoutSeconds)
    : e.exitCode !== undefined
      ? `exit ${e.exitCode}`
      : 'failed';
  // Split/trim/join, not a regex: `\s*\n\s*` backtracks polynomially on long runs of whitespace in uncontrolled output.
  const tail = e.tail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' | ');
  return `${e.checker}: ${what}${e.command ? ` — \`${e.command}\`` : ''}${tail ? `: ${tail}` : ''}`;
}

/** Every evidence entry on one line, `; `-separated — the text the lane-paused event, base hold and status quote. */
export function describeBaseHealthEvidence(evidence: readonly BaseHealthEvidence[]): string {
  return evidence.map(renderBaseHealthEvidence).join('; ');
}

/** run-issue's environment-released line for a red or inconclusive base, with the evidence. */
export function baseHealthReleasedMessage(health: BaseHealthResult, ref: string, workKey: string | number): string {
  const verdict =
    health.kind === 'red'
      ? `fails ${health.failingChecks.join(', ')} before PLAN`
      : 'base checks could not run before PLAN (not a test failure)';
  const evidence = describeBaseHealthEvidence(health.evidence ?? []);
  const base = `${ref} ${(health.baseSha ?? '').slice(0, 8)}`;
  return `${base} ${verdict}${evidence ? ` — ${evidence}` : ''} — no model calls, releasing #${workKey} to queued`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function resolveBaseSha(opts: BaseHealthOptions): Promise<string | undefined> {
  const run = opts.deps?.runCommand ?? runCommand;
  try {
    const res = await run(['git', 'rev-parse', '--verify', `${opts.baseRef ?? 'origin/main'}^{commit}`], {
      cwd: opts.worktree,
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
    });
    const sha = res.stdout.trim();
    return res.exitCode === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** Runs compile/lint/tests on origin/main once per base SHA (shared in-process, file-cached across processes). Never throws. */
export async function checkBaseHealth(opts: BaseHealthOptions): Promise<BaseHealthResult> {
  const {
    worktree,
    constitution,
    router,
    env,
    cachePath,
    timeoutSeconds,
    testsTimeoutSeconds,
    compileTimeoutSeconds,
    log,
    deps = {},
  } = opts;
  const ref = opts.baseRef ?? 'origin/main';
  try {
    const baseSha = await resolveBaseSha(opts);
    if (baseSha === undefined) {
      const reason = `${ref} not resolvable`;
      log('check', `base health skipped: ${reason}`);
      return { kind: 'skipped', failingChecks: [], cached: false, reason };
    }
    const sha8 = baseSha.slice(0, 8);
    const map = deps.memo ?? defaultMemo;
    const key = `${baseSha}:${hashBaselineEnv(env)}:${hashBaselineCheckerConfig(constitution)}`;
    const memoized = map.has(key);
    if (!memoized) {
      map.set(
        key,
        (deps.runBaseline ?? runBaselineCheckers)({
          baseSha,
          laneWorktree: worktree,
          failing: BASE_HEALTH_CHECKERS.map((checker) => ({ checker, result: 'FAIL' as const, details: '' })),
          ctx: { worktree, specPath: '', env, testsTimeoutSeconds, compileTimeoutSeconds },
          router,
          constitution,
          customCheckerTimeoutSeconds: timeoutSeconds,
          cache: cachePath === undefined ? undefined : new BaselineCache(cachePath, undefined, opts.cacheTtlHours),
          deps: deps.baselineDeps,
        }),
      );
    }
    let report: BaselineReport;
    try {
      report = await (map.get(key) as Promise<BaselineReport>);
    } catch (err) {
      map.delete(key);
      report = { baseSha, checkers: [], error: errorMessage(err) };
    }
    if (report.error !== undefined) {
      map.delete(key);
      log('environment_warning', `base health skipped: ${report.error}`);
      return { kind: 'skipped', baseSha, failingChecks: [], cached: false, reason: report.error };
    }
    let failing = report.checkers
      .filter((c) => c.verdict === 'fails-on-base' && inconclusiveOf(c) === undefined)
      .map((c) => c.checker);
    const timedOut = report.checkers.find(
      (c) => c.checker === 'compile' && c.verdict === 'fails-on-base' && c.baseTimedOut === true,
    );
    let ciPending = false;
    let ciLookup: Promise<RequiredChecksVerdict> | undefined;
    const ciVerdict = (): Promise<RequiredChecksVerdict> => {
      ciLookup ??= (async () => {
        try {
          return (await opts.requiredChecksVerdict?.(baseSha)) ?? { green: false, reason: 'CI lookup unavailable' };
        } catch (err) {
          return { green: false, reason: `CI lookup failed: ${errorMessage(err)}` };
        }
      })();
      return ciLookup;
    };
    if (timedOut) {
      map.delete(key);
      const verdict = await ciVerdict();
      if (verdict.green) {
        failing = failing.filter((c) => c !== 'compile');
        log(
          'check',
          `base health: compile timed out locally on ${ref} ${baseSha} but GitHub CI is green (${verdict.reason}) — overriding compile to passing`,
        );
      } else {
        ciPending = true;
        log(
          'check',
          `base health: compile timed out locally on ${ref} ${sha8}; GitHub CI not green (${verdict.reason}) — holding`,
        );
      }
    }
    const confirmedSet = deps.confirmed ?? defaultConfirmed;
    let confirmedLocally = false;
    let comparisons = report.checkers;
    if (confirmedSet.has(key) && failing.length > 0) {
      confirmedLocally = true;
    } else {
      const cachedFailing = comparisons
        .filter(
          (c) =>
            c.verdict === 'fails-on-base' &&
            c.cached === true &&
            c.baseTimedOut !== true &&
            failing.includes(c.checker),
        )
        .map((c) => c.checker);
      const verdict = cachedFailing.length > 0 ? await ciVerdict() : undefined;
      if (verdict?.green) {
        log(
          'check',
          `base health: cached FAIL (${cachedFailing.join(', ')}) on ${ref} ${sha8} but GitHub CI is green (${verdict.reason}) — re-running once with the cache bypassed`,
        );
        for (const checker of cachedFailing) {
          if (cachePath !== undefined) {
            await new BaselineCache(cachePath, undefined, opts.cacheTtlHours)
              .delete(baseSha, hashBaselineEnv(env), checker)
              .catch(() => false);
          }
          log(
            'baseline-cache-invalidated',
            `baseline cache invalidated: ${baseSha} ${checker} — cached FAIL but GitHub CI is green (${verdict.reason})`,
          );
        }
        const captured: CheckerOutput[] = [];
        const innerRun = deps.baselineDeps?.runCheckers ?? runAllCheckers;
        const capture: typeof runAllCheckers = async (...args) => {
          const summary = await innerRun(...args);
          captured.push(...summary.results);
          return summary;
        };
        let fresh: BaselineReport | undefined;
        try {
          fresh = await (deps.runBaseline ?? runBaselineCheckers)({
            baseSha,
            laneWorktree: worktree,
            failing: cachedFailing.map((checker) => ({ checker, result: 'FAIL' as const, details: '' })),
            ctx: { worktree, specPath: '', env, testsTimeoutSeconds, compileTimeoutSeconds },
            router,
            constitution,
            customCheckerTimeoutSeconds: timeoutSeconds,
            cache: cachePath === undefined ? undefined : new BaselineCache(cachePath, undefined, opts.cacheTtlHours),
            deps: { ...deps.baselineDeps, runCheckers: capture },
            bypassCache: true,
          });
        } catch (err) {
          fresh = { baseSha, checkers: [], error: errorMessage(err) };
        }
        if (fresh.error !== undefined) {
          log(
            'environment_warning',
            `base health: fresh re-run on ${sha8} failed: ${fresh.error} — keeping the cached result`,
          );
        } else {
          const confirmed = fresh.checkers
            .filter((c) => c.verdict === 'fails-on-base' && inconclusiveOf(c) === undefined)
            .map((c) => c.checker);
          failing = failing.filter((c) => !cachedFailing.includes(c) || confirmed.includes(c));
          comparisons = [...comparisons.filter((c) => !cachedFailing.includes(c.checker)), ...fresh.checkers];
          map.set(key, Promise.resolve({ ...report, checkers: comparisons }));
          if (confirmed.length > 0) {
            confirmedSet.add(key);
            confirmedLocally = true;
            for (const checker of confirmed) {
              const tail = redactSecrets(captured.find((o) => o.checker === checker)?.details ?? '').slice(
                -BASE_DIVERGENCE_TAIL_CHARS,
              );
              log(
                'base_divergence',
                `base divergence: ${ref} ${baseSha} — ${checker} fails locally on a fresh re-run but GitHub CI is green (${verdict.reason}); holding until the SHA changes. Output tail: ${tail}`,
              );
            }
          }
        }
      }
    }
    const hosted = await ciVerdict();
    if (hosted.state === 'failed' && !hosted.noCodeHealthChecks) {
      failing.push('hosted-ci');
      log('check', `base health: hosted CI failed on ${ref} ${baseSha}: ${hosted.reason}`);
    }
    const cached = memoized || comparisons.some((c) => c.cached === true);
    if (cached) {
      log('check', `base health: cache hit for ${sha8} (${memoized ? 'shared with another lane' : 'baseline cache'})`);
    }
    const inconclusive = comparisons.filter((c) => inconclusiveOf(c) !== undefined).map(toEvidence);
    const evidence = [
      ...comparisons.filter((c) => c.verdict === 'fails-on-base' && failing.includes(c.checker)).map(toEvidence),
      ...inconclusive,
    ];
    // An inconclusive base result must never outlive the environment that produced it.
    if (inconclusive.length > 0) map.delete(key);
    if (failing.length > 0) {
      log('check', `base health: ${ref} ${sha8} is red (${failing.join(', ')})`);
      const awaitingCi = ciPending && failing.length === 1 && failing[0] === 'compile';
      return {
        kind: 'red',
        baseSha,
        failingChecks: failing,
        cached,
        ...(hosted.state === 'failed' && !hosted.noCodeHealthChecks ? { reason: hosted.reason } : {}),
        ...(awaitingCi ? { awaitingCi } : {}),
        ...(confirmedLocally ? { confirmedLocally: true } : {}),
        ...(evidence.length > 0 ? { evidence } : {}),
      };
    }
    if (inconclusive.length > 0) {
      const reason = describeBaseHealthEvidence(inconclusive);
      log(
        'environment_warning',
        `base health: ${ref} ${sha8} is inconclusive — a base check could not run, not a test failure: ${reason}`,
      );
      return { kind: 'inconclusive', baseSha, failingChecks: [], cached, reason, evidence: inconclusive };
    }
    log('check', `base health: ${ref} ${sha8} is green`);
    return { kind: 'green', baseSha, failingChecks: [], cached };
  } catch (err) {
    const reason = errorMessage(err);
    log('environment_warning', `base health skipped: ${reason}`);
    return { kind: 'skipped', failingChecks: [], cached: false, reason };
  }
}
