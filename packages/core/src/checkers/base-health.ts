// src/checkers/base-health.ts — pre-PLAN health check of origin/main, cached per base SHA (#2339)

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

/** Deterministic checkers that never call a model; the only ones run on base before PLAN. */
export const BASE_HEALTH_CHECKERS: readonly string[] = ['compile', 'lint', 'tests'];

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
  /** At least one cached base failure was reproduced by a fresh local run. */
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
  /** Custom-checker timeout in seconds (`request.timeouts.check`). */
  timeoutSeconds?: number;
  /** Tests checker timeout in seconds (`request.timeouts.tests`, #3095); undefined = the tests checker's 300s default. */
  testsTimeoutSeconds?: number;
  /** Compile checker timeout in seconds (`request.timeouts.compile`, #3185); undefined = the compile checker's 120s default. */
  compileTimeoutSeconds?: number;
  /** Strict GitHub CI lookup for compile timeouts and cached-failure reconciliation; absent = CI unknown. */
  requiredChecksVerdict?: (sha: string) => Promise<RequiredChecksVerdict>;
  log: (type: EventKind, msg: string) => void;
  deps?: {
    runCommand?: typeof runCommand;
    runBaseline?: typeof runBaselineCheckers;
    baselineDeps?: BaselineDeps;
    memo?: Map<string, Promise<BaselineReport>>;
  };
}

const defaultMemo = new Map<string, Promise<BaselineReport>>();

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
    const runBaseline = deps.runBaseline ?? runBaselineCheckers;
    const baselineCache = cachePath === undefined ? undefined : new BaselineCache(cachePath);
    if (!memoized) {
      map.set(
        key,
        runBaseline({
          baseSha,
          laneWorktree: worktree,
          failing: BASE_HEALTH_CHECKERS.map((checker) => ({ checker, result: 'FAIL' as const, details: '' })),
          ctx: { worktree, specPath: '', env, testsTimeoutSeconds, compileTimeoutSeconds },
          router,
          constitution,
          customCheckerTimeoutSeconds: timeoutSeconds,
          cache: baselineCache,
          deps: deps.baselineDeps,
        }),
      );
    }
    const observedPromise = map.get(key) as Promise<BaselineReport>;
    let report: BaselineReport;
    try {
      report = await observedPromise;
    } catch (err) {
      map.delete(key);
      report = { baseSha, checkers: [], error: errorMessage(err) };
    }
    if (report.error !== undefined) {
      map.delete(key);
      log('environment_warning', `base health skipped: ${report.error}`);
      return { kind: 'skipped', baseSha, failingChecks: [], cached: false, reason: report.error };
    }
    let ciVerdict: RequiredChecksVerdict | undefined;
    let ciLookedUp = false;
    const cachedFailures = report.checkers.filter(
      (comparison) =>
        comparison.verdict === 'fails-on-base' &&
        comparison.baseTimedOut !== true &&
        comparison.confirmedLocally !== true &&
        (memoized || comparison.cached === true),
    );
    if (cachedFailures.length > 0 && opts.requiredChecksVerdict) {
      try {
        ciLookedUp = true;
        ciVerdict = await opts.requiredChecksVerdict(baseSha);
      } catch {
        ciVerdict = undefined;
      }
      if (ciVerdict?.green === true) {
        const current = map.get(key);
        if (current !== undefined && current !== observedPromise) {
          try {
            report = await (current as Promise<BaselineReport>);
          } catch (err) {
            map.delete(key);
            report = { baseSha, checkers: [], error: errorMessage(err) };
          }
        } else {
          const selected = new Set(cachedFailures.map((comparison) => comparison.checker));
          const reconciliation = runBaseline({
            baseSha,
            laneWorktree: worktree,
            failing: cachedFailures.map((comparison) => ({
              checker: comparison.checker,
              result: 'FAIL' as const,
              details: '',
            })),
            ctx: { worktree, specPath: '', env, testsTimeoutSeconds, compileTimeoutSeconds },
            router,
            constitution,
            customCheckerTimeoutSeconds: timeoutSeconds,
            cache: baselineCache,
            deps: deps.baselineDeps,
            bypassCache: true,
          }).then((freshReport) => {
            if (freshReport.error !== undefined) return freshReport;
            const byChecker = new Map(freshReport.checkers.map((comparison) => [comparison.checker, comparison]));
            const merged = report.checkers.map((previous) => {
              if (!selected.has(previous.checker)) return previous;
              const fresh = byChecker.get(previous.checker);
              if (!fresh || fresh.verdict === 'not-run' || fresh.baseTimedOut === true || fresh.baseResult === 'SKIP')
                return previous;
              if (fresh.verdict === 'fails-on-base') {
                fresh.confirmedLocally = true;
                opts.log(
                  'base_divergence',
                  `base ${baseSha} checker ${fresh.checker} still fails locally:\n${fresh.baseDetails ?? ''}`,
                );
              }
              return fresh;
            });
            return { ...report, checkers: merged };
          });
          map.set(key, reconciliation);
          try {
            report = await reconciliation;
          } catch (err) {
            map.delete(key);
            report = { baseSha, checkers: [], error: errorMessage(err) };
          }
          if (report.error !== undefined) map.delete(key);
        }
      }
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
    const confirmedLocally = report.checkers.some((comparison) => comparison.confirmedLocally === true);
    if (timedOut) {
      if (!confirmedLocally) map.delete(key);
      let verdict = ciVerdict;
      if (verdict === undefined && !ciLookedUp) {
        try {
          ciLookedUp = true;
          verdict = (await opts.requiredChecksVerdict?.(baseSha)) ?? { green: false, reason: 'CI lookup unavailable' };
        } catch (err) {
          verdict = { green: false, reason: `CI lookup failed: ${errorMessage(err)}` };
        }
      }
      verdict ??= { green: false, reason: 'CI lookup unavailable' };
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
    const cached = memoized || report.checkers.some((c) => c.cached === true);
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
