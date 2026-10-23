// src/checkers/base-health.ts — pre-PLAN health check of origin/main, cached per base SHA (#2339).
// #3287: a cached non-timeout FAIL whose SHA GitHub CI calls green is re-run once, fresh; a fresh
// FAIL is `confirmedLocally` (logged as base_divergence) and never re-run for that SHA in-process.
// #3540: that cached FAIL is also deleted from the cache file and logged as baseline-cache-invalidated.

import type { EventKind } from '../events/kinds.js';
import type { ModelRouter } from '../router/index.js';
import type { Constitution } from '../types/index.js';
import { runCommand } from '../utils/command-runner.js';
import { GIT_COMMAND_TIMEOUT_MS } from '../utils/git-exec.js';
import type { RequiredChecksVerdict } from '../utils/required-checks.js';

// The strict CI lookup rides with base health on the internal surface (#3186).
export { fetchRequiredChecksVerdict, type RequiredChecksVerdict } from '../utils/required-checks.js';
import { type BaselineDeps, type BaselineReport, runBaselineCheckers } from './baseline.js';
import { BaselineCache, hashBaselineCheckerConfig, hashBaselineEnv } from './baseline-cache.js';
import { runAllCheckers } from './index.js';
import type { CheckerOutput } from '../types/index.js';

/** Deterministic checkers that never call a model; the only ones run on base before PLAN. */
export const BASE_HEALTH_CHECKERS: readonly string[] = ['compile', 'lint', 'tests'];

/** Chars of the fresh checker output kept in a base_divergence event (#3287). */
export const BASE_DIVERGENCE_TAIL_CHARS = 500;

export interface BaseHealthResult {
  /** red = at least one BASE_HEALTH_CHECKERS checker FAILs on base; skipped = could not decide (fail open). */
  kind: 'green' | 'red' | 'skipped';
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
}

export interface BaseHealthOptions {
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function resolveBaseSha(opts: BaseHealthOptions): Promise<string | undefined> {
  const run = opts.deps?.runCommand ?? runCommand;
  try {
    const res = await run(['git', 'rev-parse', '--verify', 'origin/main^{commit}'], {
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
  try {
    const baseSha = await resolveBaseSha(opts);
    if (baseSha === undefined) {
      const reason = 'origin/main not resolvable';
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
    let failing = report.checkers.filter((c) => c.verdict === 'fails-on-base').map((c) => c.checker);
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
          `base health: compile timed out locally on origin/main ${baseSha} but GitHub CI is green (${verdict.reason}) — overriding compile to passing`,
        );
      } else {
        ciPending = true;
        log(
          'check',
          `base health: compile timed out locally on origin/main ${sha8}; GitHub CI not green (${verdict.reason}) — holding`,
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
          `base health: cached FAIL (${cachedFailing.join(', ')}) on origin/main ${sha8} but GitHub CI is green (${verdict.reason}) — re-running once with the cache bypassed`,
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
          const confirmed = fresh.checkers.filter((c) => c.verdict === 'fails-on-base').map((c) => c.checker);
          failing = failing.filter((c) => !cachedFailing.includes(c) || confirmed.includes(c));
          comparisons = [...comparisons.filter((c) => !cachedFailing.includes(c.checker)), ...fresh.checkers];
          map.set(key, Promise.resolve({ ...report, checkers: comparisons }));
          if (confirmed.length > 0) {
            confirmedSet.add(key);
            confirmedLocally = true;
            for (const checker of confirmed) {
              const tail = (captured.find((o) => o.checker === checker)?.details ?? '').slice(
                -BASE_DIVERGENCE_TAIL_CHARS,
              );
              log(
                'base_divergence',
                `base divergence: origin/main ${baseSha} — ${checker} fails locally on a fresh re-run but GitHub CI is green (${verdict.reason}); holding until the SHA changes. Output tail: ${tail}`,
              );
            }
          }
        }
      }
    }
    const cached = memoized || comparisons.some((c) => c.cached === true);
    if (cached) {
      log('check', `base health: cache hit for ${sha8} (${memoized ? 'shared with another lane' : 'baseline cache'})`);
    }
    if (failing.length > 0) {
      log('check', `base health: origin/main ${sha8} is red (${failing.join(', ')})`);
      const awaitingCi = ciPending && failing.length === 1 && failing[0] === 'compile';
      return {
        kind: 'red',
        baseSha,
        failingChecks: failing,
        cached,
        ...(awaitingCi ? { awaitingCi } : {}),
        ...(confirmedLocally ? { confirmedLocally: true } : {}),
      };
    }
    log('check', `base health: origin/main ${sha8} is green`);
    return { kind: 'green', baseSha, failingChecks: [], cached };
  } catch (err) {
    const reason = errorMessage(err);
    log('environment_warning', `base health skipped: ${reason}`);
    return { kind: 'skipped', failingChecks: [], cached: false, reason };
  }
}
