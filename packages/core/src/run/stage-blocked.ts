// src/run/stage-blocked.ts — stage-boundary provider gate (#3226): which configured providers of a
// stage are capped, which to skip, and when the whole stage is blocked until a timed reset.

import { formatBreakerRemaining, type ProviderBreaker } from '../router/breaker.js';
import { routerFailureOf } from '../router/executor-error.js';
import type { ModelRouter } from '../router/index.js';
import type { EventKind } from '../events/kinds.js';
import type { FailoverReason, FailurePhase } from '../types/index.js';
import type { BuildRoute, RunOutcome } from './outcome.js';

export type GateStage = 'plan' | 'build' | 'check';

/** Breaker reasons whose entry carries a real reset time; only these release to queued (#3226). */
export const TIMED_BREAKER_REASONS: ReadonlySet<FailoverReason> = new Set(['usage_cap', 'rate_limit']);

/** Router failure reasons that mean the provider, not the issue, failed. */
export const PROVIDER_LEVEL_REASONS: ReadonlySet<string> = new Set([
  'usage_cap',
  'rate_limit',
  'timeout',
  'unavailable',
]);

export interface StageBlockedResult {
  /** Every counted candidate provider is open. */
  blocked: boolean;
  /** Open counted providers, candidate order. */
  providers: string[];
  /** Providers to pass as router `skipProviders` (empty when blocked or failover is disabled). */
  skip: Set<string>;
  /** ISO instant of the earliest reset among open counted providers with a timed reason. */
  nextAvailableAt?: string;
}

export interface StageBlockedDeps {
  router: Pick<ModelRouter, 'registryRef'>;
  breaker: ProviderBreaker;
  /** Candidate model ids in the stage's configured order. */
  candidates: readonly string[];
  failoverEnabled: boolean;
  log?: (type: EventKind, msg: string) => void;
  now?: () => number;
}

/** Read the breaker for the stage's candidate providers: skip the open ones, or report the stage blocked. */
export async function stageBlocked(stage: GateStage, deps: StageBlockedDeps): Promise<StageBlockedResult> {
  const { registryRef } = deps.router;
  const all = [
    ...new Set(deps.candidates.map((id) => registryRef.get(id)?.provider).filter((p): p is string => Boolean(p))),
  ];
  const counted = deps.failoverEnabled ? all : all.slice(0, 1);
  if (counted.length === 0) return { blocked: false, providers: [], skip: new Set() };
  const now = deps.now ?? Date.now;
  const open: { provider: string; reason: FailoverReason; remainingMs: number }[] = [];
  for (const provider of counted) {
    const status = await deps.breaker.status(provider);
    if (status.open) open.push({ provider, reason: status.entry.reason, remainingMs: status.remainingMs });
  }
  const blocked = open.length === counted.length;
  const resets = open
    .filter((o) => TIMED_BREAKER_REASONS.has(o.reason) && Number.isFinite(o.remainingMs))
    .map((o) => now() + o.remainingMs);
  const skip = new Set<string>();
  if (deps.failoverEnabled && !blocked) {
    for (const o of open) {
      skip.add(o.provider);
      deps.log?.(
        'provider_breaker_skip',
        `breaker open for ${o.provider} (${o.reason}) — skipping it for ${stage.toUpperCase()}, ${formatBreakerRemaining(o.remainingMs)}`,
      );
    }
  }
  return {
    blocked,
    providers: open.map((o) => o.provider),
    skip,
    ...(resets.length > 0 ? { nextAvailableAt: new Date(Math.min(...resets)).toISOString() } : {}),
  };
}

/** Candidates for PLAN in today's order: the pin then its fallback, else the plan tier. */
function planCandidates(router: Pick<ModelRouter, 'resolveAll'>, pins: GateRequest['modelPins']): string[] {
  if (!pins.plan) return router.resolveAll('plan');
  return [...new Set([pins.plan, pins.planFallback].filter((m): m is string => Boolean(m)))];
}

/** Models that can run a build route today, the chosen model first; empty for the `command` route.
 *  When failover is on, BUILD's cross-harness ladder (buildFallback, build_claude, build_codex) counts too. */
function buildCandidates(
  router: Pick<ModelRouter, 'resolveAll'>,
  route: BuildRoute,
  model: string | undefined,
  ladder?: { buildFallback?: string; codexOff: boolean },
): string[] {
  if (route === 'command') return [];
  const more = ladder
    ? [
        ladder.buildFallback,
        ...router.resolveAll('build_claude'),
        ...(ladder.codexOff ? [] : router.resolveAll('build_codex')),
      ]
    : [];
  return [...new Set([model, ...router.resolveAll(`build_${route}`), ...more].filter((m): m is string => Boolean(m)))];
}

type GateLog = (type: EventKind, msg: string) => void;

/** What a stage boundary decided: providers to skip, or a release outcome when the stage is blocked until a reset. */
export interface StageGateVerdict {
  skip: Set<string>;
  released?: RunOutcome;
}

/** The slice of a run request the gate reads. */
export interface GateRequest {
  issue: number;
  branch: string;
  codexDisabled: boolean;
  failover: { enabled: boolean };
  modelPins: { plan?: string; planFallback?: string; buildFallback?: string };
}

/**
 * Per-run gate over `stageBlocked` (#3226). `enter` runs at a stage boundary; `watch` records a stage that has no
 * boundary gate (CHECK); `afterFailure` turns a provider-level router failure of the current stage into the same
 * release when the stage is now timed-blocked.
 */
export function providerCapGate(
  router: Pick<ModelRouter, 'registryRef' | 'resolveAll'>,
  breaker: ProviderBreaker,
  request: GateRequest,
  log: GateLog,
) {
  const { issue, branch } = request;
  const failoverEnabled = request.failover.enabled;
  let current: { stage: GateStage; candidates: string[] } | undefined;
  const release = (
    stage: GateStage,
    gate: StageBlockedResult,
    route: BuildRoute | undefined,
  ): RunOutcome | undefined => {
    if (!gate.blocked || !gate.nextAvailableAt) return undefined;
    log(
      'provider-cap-released',
      `every ${stage.toUpperCase()} provider is capped (${gate.providers.join(', ')}) — no model call, releasing #${issue} to queued until ${gate.nextAvailableAt}`,
    );
    return {
      state: 'released',
      reason: 'provider-cap',
      route,
      branch,
      reworkRounds: 0,
      providers: gate.providers,
      resetAt: gate.nextAvailableAt,
    };
  };
  const enter = async (
    stage: GateStage,
    candidates: string[],
    route: BuildRoute | undefined,
    stageLog?: GateLog,
  ): Promise<StageGateVerdict> => {
    current = { stage, candidates };
    const gate = await stageBlocked(stage, { router, breaker, candidates, failoverEnabled, log: stageLog });
    return { skip: gate.skip, released: release(stage, gate, route) };
  };
  return {
    /** CHECK has no boundary gate (BUILD just succeeded); record it for the catch path. */
    watchCheck(route: BuildRoute, model: string | undefined): void {
      current = { stage: 'check', candidates: buildCandidates(router, route, model) };
    },
    enterPlan(route: BuildRoute | undefined, stageLog: GateLog): Promise<StageGateVerdict> {
      return enter('plan', planCandidates(router, request.modelPins), route, stageLog);
    },
    /** Release only: BUILD's own gates log skips and its ladder stays (#1449). */
    enterBuild(
      buildRoute: BuildRoute,
      model: string | undefined,
      route: BuildRoute | undefined,
      breakerBlocked: boolean,
    ): Promise<StageGateVerdict> {
      const codexOff = request.codexDisabled || breakerBlocked;
      const ladder = failoverEnabled ? { buildFallback: request.modelPins.buildFallback, codexOff } : undefined;
      return enter('build', buildCandidates(router, buildRoute, model, ladder), route);
    },
    async afterFailure(err: unknown, failurePhase: FailurePhase, route: BuildRoute | undefined) {
      const failure = routerFailureOf(err);
      if (!failure || !PROVIDER_LEVEL_REASONS.has(failure.reason) || failure.detail === 'only_metered_left') {
        return undefined;
      }
      if (!current || failurePhase === 'ship') return undefined;
      const { stage, candidates } = current;
      try {
        return release(stage, await stageBlocked(stage, { router, breaker, candidates, failoverEnabled }), route);
      } catch (e) {
        // an unreadable breaker must not change how the failure parks, but it must be visible
        log('environment_warning', `provider-cap check failed: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
    },
  };
}
