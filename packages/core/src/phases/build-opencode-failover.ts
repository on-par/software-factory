import { parseResetCooldownMs } from '../router/breaker.js';
import { ModelRouterError, type RouterAttempt } from '../router/executor-error.js';
import type { ModelRouter, RouterResult } from '../router/index.js';
import { applySteering, type ConsumedSteering } from '../steering/index.js';
import type { FailoverReason } from '../types/index.js';

type Log = (type: 'worker_failover', msg: string, extra: { failoverReason: FailoverReason }) => void;

/** oc-08's cross-harness order for leaving OpenCode: the first build_claude worker, else the first
 *  build_codex worker unless codex is disabled. Shared by in-phase failover and runIssue's
 *  pre-BUILD breaker gate (#2891). */
export function pickOpencodeFallback(
  router: ModelRouter,
  codexDisabled?: boolean,
): { route: 'claude' | 'codex'; task: 'build_claude' | 'build_codex'; model: string } | undefined {
  const claudeModel = router.resolveAll('build_claude')[0];
  if (claudeModel) return { route: 'claude', task: 'build_claude', model: claudeModel };
  const codexModel = codexDisabled ? undefined : router.resolveAll('build_codex')[0];
  return codexModel ? { route: 'codex', task: 'build_codex', model: codexModel } : undefined;
}

/** ISO instant the latest capped attempt says OpenCode resets, parsed from the attempt details with the
 *  breaker's own parser (no padding); undefined when no attempt carries a reset hint. */
export function opencodeCapResetAt(attempts: readonly RouterAttempt[], now = Date.now()): string | undefined {
  let latest: number | undefined;
  for (const attempt of attempts) {
    if (!attempt.detail) continue;
    const ms = parseResetCooldownMs(attempt.detail, 0, now);
    if (ms !== null && (latest === undefined || ms > latest)) latest = ms;
  }
  return latest === undefined ? undefined : new Date(now + latest).toISOString();
}

const WHY_TEXT = {
  'route-pinned': 'build route pinned to opencode in .factory/config.json (ADR-0092)',
  'auto-failover-off': 'auto-failover disabled',
  'no-harness': 'no other build harness allowed',
} as const;

/** The error a capped OpenCode BUILD fails with when it does not fail over: keeps the router error's
 *  reason and attempts, and names the cap reason, why it stayed, and the reset time. */
export function opencodeCapError(opts: {
  err: unknown;
  reason: FailoverReason;
  attempts: RouterAttempt[];
  why: keyof typeof WHY_TEXT;
  now?: number;
}): ModelRouterError {
  const resetAt = opencodeCapResetAt(opts.attempts, opts.now);
  const reset = resetAt ? `resets at ${resetAt}` : 'reset time unknown';
  const original = opts.err instanceof Error ? opts.err.message : String(opts.err);
  return new ModelRouterError(
    `OpenCode build workers capped (${opts.reason}); not failing over: ${WHY_TEXT[opts.why]}; ${reset} — ${original}`,
    opts.reason,
    opts.attempts,
  );
}

/**
 * Where an OpenCode BUILD continues once every build_opencode worker is capped (#2885): the first
 * build_claude worker, else the first build_codex worker. Throws a cap error (#3034) when the repo
 * pinned the route (ADR-0092), auto-failover is off, or no target worker exists.
 */
export async function failOverOpencodeBuild(opts: {
  router: ModelRouter;
  reason: FailoverReason;
  err: unknown;
  attempts: RouterAttempt[];
  runOpts: Parameters<ModelRouter['run']>[2];
  prompts: { claude: () => string; codex: () => string };
  build: {
    steering?: ConsumedSteering;
    log: Log;
    routePinned?: boolean;
    autoFailover?: { enabled: boolean };
    codexDisabled?: boolean;
  };
}): Promise<{ route: 'claude' | 'codex'; result: RouterResult }> {
  const { router, reason, err, attempts } = opts;
  const fromModel = attempts.at(-1)?.model ?? 'unknown';
  if (opts.build.routePinned === true) throw opencodeCapError({ err, reason, attempts, why: 'route-pinned' });
  if (opts.build.autoFailover && !opts.build.autoFailover.enabled)
    throw opencodeCapError({ err, reason, attempts, why: 'auto-failover-off' });
  const target = pickOpencodeFallback(router, opts.build.codexDisabled);
  if (!target) throw opencodeCapError({ err, reason, attempts, why: 'no-harness' });
  opts.build.log(
    'worker_failover',
    `OpenCode build workers exhausted (${reason}) — continuing on ${target.route}: ` +
      `from_model=${fromModel} to_model=${target.model} ` +
      `from_route=build_opencode to_route=${target.task} reason=${reason}`,
    { failoverReason: reason },
  );
  const prompt = applySteering(opts.prompts[target.route](), opts.build.steering);
  // modelOverride must be the chosen model: runOpts may hold the opencode pin.
  const result = await router.run(target.task, prompt, {
    ...opts.runOpts,
    retryCause: 'failover',
    modelOverride: target.model,
  });
  return { route: target.route, result };
}
