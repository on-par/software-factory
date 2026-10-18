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
  /** Strict GitHub CI lookup for a timed-out compile (#3186); absent = CI unknown. */
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
          cache: cachePath === undefined ? undefined : new BaselineCache(cachePath),
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
    if (timedOut) {
      map.delete(key);
      let verdict: RequiredChecksVerdict;
      try {
        verdict = (await opts.requiredChecksVerdict?.(baseSha)) ?? { green: false, reason: 'CI lookup unavailable' };
      } catch (err) {
        verdict = { green: false, reason: `CI lookup failed: ${errorMessage(err)}` };
      }
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
      return { kind: 'red', baseSha, failingChecks: failing, cached, ...(awaitingCi ? { awaitingCi } : {}) };
    }
    log('check', `base health: origin/main ${sha8} is green`);
    return { kind: 'green', baseSha, failingChecks: [], cached };
  } catch (err) {
    const reason = errorMessage(err);
    log('environment_warning', `base health skipped: ${reason}`);
    return { kind: 'skipped', failingChecks: [], cached: false, reason };
  }
}
