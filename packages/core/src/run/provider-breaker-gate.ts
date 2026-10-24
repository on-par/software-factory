import { pickOpencodeFallback } from '../phases/build-opencode-failover.js';
import { formatBreakerRemaining, gateBuildOnBreaker, type ProviderBreaker } from '../router/breaker.js';
import type { ModelRouter } from '../router/index.js';
import type { EventKind } from '../events/kinds.js';
import type { ProviderBreakerClosePayload, ProviderFailoverPayload } from '../events/payloads.js';
import type { FailoverReason } from '../types/index.js';
import {
  subscriptionProviderOf,
  type ProviderOrder,
  type ProviderOrderRole,
  type SubscriptionProviderId,
} from '../config/provider-order.js';
import { routerFailureOf } from '../router/executor-error.js';
import type { BuildRoute } from './outcome.js';
import { probeIfDue, type ProviderProbe } from './provider-probe.js';

type GateLog = (
  type: EventKind,
  msg: string,
  extra?: {
    failoverReason?: FailoverReason;
    providerBreakerClose?: ProviderBreakerClosePayload;
    providerFailover?: ProviderFailoverPayload;
  },
) => void;

type GateDeps = { router: ModelRouter; breaker: ProviderBreaker; log: GateLog };

/** The fallback model when the primary's provider breaker is open, else the primary (logs provider_breaker_skip). */
async function preferFallbackWhenProviderIsOpen(
  deps: GateDeps,
  primary: string | undefined,
  fallback: string | undefined,
  phase: string,
): Promise<string | undefined> {
  if (!primary || !fallback) return primary;
  const provider = deps.router.registryRef.get(primary)?.provider;
  if (!provider) return primary;
  const status = await deps.breaker.status(provider);
  if (!status.open) {
    if (status.justClosed) {
      const cause = status.closeCause ?? 'cooldown';
      deps.log('provider_breaker_close', `breaker closed for ${provider} (${cause})`, {
        providerBreakerClose: { provider, cause },
      });
    }
    return primary;
  }
  deps.log(
    'provider_breaker_skip',
    `breaker open for ${provider} (${status.entry.reason}) — using ${fallback} for ${phase}, ${formatBreakerRemaining(status.remainingMs)}`,
  );
  return fallback;
}

export type OpencodeBreakerGate =
  | {
      kind: 'swap';
      route: 'claude' | 'codex';
      task: 'build_claude' | 'build_codex';
      model: string;
      reason: FailoverReason;
    }
  | { kind: 'blocked'; reason: FailoverReason; resetAt: string; message: string };

/**
 * Pre-BUILD breaker gate for the opencode route (#2891, #3035). Unpinned: returns a swap to the first
 * build_claude (else build_codex) worker, with the breaker reason (also logged as worker_failover), when the opencode model's provider breaker
 * is open. Pinned by the repo (ADR-0092): never swaps; returns a blocked result carrying the cap reason and
 * reset time so BUILD fails fast instead of starting on a capped provider.
 */
export async function gateOpencodeBuildOnBreaker(
  deps: GateDeps,
  opts: { opencodeModel: string | undefined; routePinned: boolean; codexDisabled: boolean; now?: number },
): Promise<OpencodeBreakerGate | undefined> {
  const { router, breaker, log } = deps;
  const { opencodeModel } = opts;
  const provider = opencodeModel ? router.registryRef.get(opencodeModel)?.provider : undefined;
  if (!provider) return undefined;
  if (opts.routePinned) {
    const status = await breaker.status(provider);
    if (!status.open) return undefined;
    const reason = status.entry.reason;
    log(
      'provider_breaker_pinned',
      `breaker open for ${provider} (${reason}) — keeping the opencode route pinned by .factory/config.json, ${formatBreakerRemaining(status.remainingMs)}`,
    );
    const resetAt = Number.isFinite(status.remainingMs)
      ? new Date((opts.now ?? Date.now()) + status.remainingMs).toISOString()
      : '';
    const resumes = resetAt ? `resets at ${resetAt}` : 'held until credentials change';
    return {
      kind: 'blocked',
      reason,
      resetAt,
      message: `OpenCode build workers capped (${reason}); not failing over: build route pinned to opencode in .factory/config.json (ADR-0092); ${resumes}`,
    };
  }
  const target = pickOpencodeFallback(router, opts.codexDisabled);
  if (!target || target.model === opencodeModel) return undefined;
  const status = await breaker.status(provider);
  if (!status.open) return undefined;
  log(
    'provider_breaker_skip',
    `breaker open for ${provider} (${status.entry.reason}) — using ${target.model} for BUILD, ${formatBreakerRemaining(status.remainingMs)}`,
  );
  log(
    'worker_failover',
    `OpenCode provider breaker open (${status.entry.reason}) — starting BUILD on ${target.route}: from_model=${opencodeModel} to_model=${target.model} from_route=build_opencode to_route=${target.task} reason=${status.entry.reason}`,
    { failoverReason: status.entry.reason },
  );
  return { kind: 'swap', route: target.route, task: target.task, model: target.model, reason: status.entry.reason };
}

export type FailoverStage = 'plan' | 'build' | 'check';
export const STAGE_ROLE: Record<FailoverStage, ProviderOrderRole> = {
  plan: 'boss',
  build: 'worker',
  check: 'checker',
};

export interface ProviderPick {
  provider: SubscriptionProviderId;
  /** The role's model for that provider. */
  model: string;
  /** Registry provider keys (breaker keys) of the order entries passed over: excluded or breaker-open. */
  skipped: Set<string>;
}

/** The first entry of `order` for the stage's role whose provider is not excluded and whose breaker is closed (#3338).
 *  A provider whose cap has passed is probed first and, when the probe passes, is the pick (#3339). */
export async function pickOrderedProvider(
  deps: { router: Pick<ModelRouter, 'registryRef'>; breaker: ProviderBreaker; probe?: ProviderProbe; log?: GateLog },
  order: ProviderOrder,
  stage: FailoverStage,
  exclude: ReadonlySet<SubscriptionProviderId>,
): Promise<ProviderPick | undefined> {
  const skipped = new Set<string>();
  for (const id of order[STAGE_ROLE[stage]]) {
    const def = deps.router.registryRef.get(id);
    const sub = subscriptionProviderOf(id, def);
    if (!def || !sub) continue;
    if (exclude.has(sub)) {
      skipped.add(def.provider);
      continue;
    }
    if (deps.probe) {
      const probed = await probeIfDue({ ...deps, probe: deps.probe }, order, sub, def.provider, id);
      if (probed === 'restored') return { provider: sub, model: id, skipped };
      if (probed !== 'not-due') {
        skipped.add(def.provider);
        continue;
      }
    }
    if ((await deps.breaker.status(def.provider)).open) {
      skipped.add(def.provider);
      continue;
    }
    return { provider: sub, model: id, skipped };
  }
  return undefined;
}

/**
 * Runs a stage's attempt on the first uncapped provider of `deps.order`. A usage_cap failure reruns the stage from its
 * start on the next uncapped provider (after `beforeRerun` restores the worktree), logging one provider_failover per
 * rerun (#3338). Any other error, no provider left, or a `beforeRerun` that returns false rethrows the original error.
 */
export async function runWithProviderFailover<T>(
  deps: {
    router: Pick<ModelRouter, 'registryRef'>;
    breaker: ProviderBreaker;
    probe?: ProviderProbe;
    log: GateLog;
    issue: number;
    order: ProviderOrder;
  },
  stage: FailoverStage,
  attempt: (pick: ProviderPick | undefined) => Promise<T>,
  hooks?: { beforeRerun?: () => Promise<boolean> },
): Promise<T> {
  const exclude = new Set<SubscriptionProviderId>();
  let pick = await pickOrderedProvider(deps, deps.order, stage, exclude);
  for (;;) {
    try {
      return await attempt(pick);
    } catch (err) {
      if (!pick || routerFailureOf(err)?.reason !== 'usage_cap') throw err;
      exclude.add(pick.provider);
      const next = await pickOrderedProvider(deps, deps.order, stage, exclude);
      if (!next) throw err;
      if (hooks?.beforeRerun && !(await hooks.beforeRerun())) throw err;
      deps.log(
        'provider_failover',
        `${stage.toUpperCase()} hit a usage cap on ${pick.provider} — rerunning ${stage.toUpperCase()} from its start on ${next.provider} (${next.model})`,
        { providerFailover: { stage, from: pick.provider, to: next.provider, issue: deps.issue } },
      );
      pick = next;
    }
  }
}

/** Whether the breaker of any provider serving build_codex is open (#2891); logs the skip. */
export async function codexBuildBlocked(
  router: ModelRouter,
  breaker: ProviderBreaker,
  log: Parameters<typeof gateBuildOnBreaker>[0]['log'],
): Promise<boolean> {
  const providers = [
    ...new Set(
      router
        .resolveAll('build_codex')
        .map((m) => router.registryRef.get(m)?.provider)
        .filter((p): p is string => Boolean(p)),
    ),
  ];
  return (await gateBuildOnBreaker({ breaker, providers, log })).codexBlocked;
}

/**
 * Pre-BUILD breaker gate when `models.providerOrder` is unset: swaps an opencode or claude build target to the
 * fallback worker when its provider breaker is open (#2891, #3035). `blocked` carries the escalation message when a
 * repo-pinned opencode route is capped.
 */
export async function gateBuildTarget(
  deps: GateDeps,
  target: { route: BuildRoute; model: string | undefined },
  opts: { routePinned: boolean; codexDisabled: boolean; buildFallback: string | undefined },
): Promise<{ route: BuildRoute; model: string | undefined; swapReason?: FailoverReason; blocked?: string }> {
  let { route, model } = target;
  let swapReason: FailoverReason | undefined;
  if (route === 'opencode') {
    const gate = await gateOpencodeBuildOnBreaker(deps, {
      opencodeModel: model ?? deps.router.resolveAll('build_opencode')[0],
      routePinned: opts.routePinned,
      codexDisabled: opts.codexDisabled,
    });
    if (gate?.kind === 'blocked') return { route, model, blocked: gate.message };
    if (gate?.kind === 'swap') {
      route = gate.route;
      model = gate.model;
      swapReason = gate.reason;
    }
  }
  if (route === 'claude') {
    const primaryClaude = model ?? deps.router.resolveAll('build_claude')[0];
    const fallbackCodex = opts.buildFallback ?? deps.router.resolveAll('build_codex')[0];
    const selected = await preferFallbackWhenProviderIsOpen(deps, primaryClaude, fallbackCodex, 'BUILD');
    if (selected && selected !== primaryClaude) {
      route = 'codex';
      model = selected;
    }
  }
  return { route, model, ...(swapReason ? { swapReason } : {}) };
}
