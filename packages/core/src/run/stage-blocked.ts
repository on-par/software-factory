// src/run/stage-blocked.ts — stage-boundary provider gate (#3226): which configured providers of a
// stage are capped, which to skip, and when the whole stage is blocked until a timed reset.

import { formatBreakerRemaining, type ProviderBreaker } from '../router/breaker.js';
import { routerFailureOf } from '../router/executor-error.js';
import type { ModelRouter } from '../router/index.js';
import type { AllProvidersDownPayload, EventKind } from '../events/kinds.js';
import type { FailoverReason, FailurePhase } from '../types/index.js';
import type { ProviderOrder } from '../config/provider-order.js';
import type { BuildRoute, RunOutcome } from './outcome.js';
import { STAGE_ROLE } from './provider-breaker-gate.js';
import { probeDueProviders, type ProviderProbe } from './provider-probe.js';

type ParkedProvidersDown = Extract<RunOutcome, { state: 'parked' }>['providersDown'];

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

export type AllProvidersDownDetail = 'untimed_breakers' | 'only_metered_left';

/** Details of an `all_providers_down` release to queued (#3340). */
export type AllProvidersDownReleaseDetail = 'all_capped' | 'reset_pending';

/** One provider that is down: its breaker reason (or 'metered'), and when it is back (ISO, 'credentials-change', or unknown). */
export interface ProviderDown {
  provider: string;
  reason: string;
  until: string | null;
}

export interface StageBlockedResult {
  /** Every counted candidate provider is open. */
  blocked: boolean;
  /** Open counted providers, candidate order. */
  providers: string[];
  /** Open counted providers with their breaker reason and reset, candidate order (#3235). */
  open: ProviderDown[];
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
  if (counted.length === 0) return { blocked: false, providers: [], open: [], skip: new Set() };
  const now = deps.now ?? Date.now;
  const open: { provider: string; reason: FailoverReason; remainingMs: number; until: string | null }[] = [];
  for (const provider of counted) {
    const status = await deps.breaker.status(provider);
    if (!status.open) continue;
    const { reason, until } = status.entry;
    const finite = Number.isFinite(status.remainingMs);
    open.push({
      provider,
      reason,
      remainingMs: status.remainingMs,
      until:
        until === 'credentials-change' ? until : finite ? new Date(now() + status.remainingMs).toISOString() : null,
    });
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
    open: open.map((o) => ({ provider: o.provider, reason: o.reason, until: o.until })),
    skip,
    ...(resets.length > 0 ? { nextAvailableAt: new Date(Math.min(...resets)).toISOString() } : {}),
  };
}

export interface AllProvidersDownResult {
  /** Every counted provider of the stage is open. */
  down: boolean;
  /** Open counted providers with breaker reason and reset. */
  providers: ProviderDown[];
  /** Earliest timed reset (usage_cap / rate_limit) among them; absent when no reset is known (#3235). */
  earliestResetAt?: string;
  skip: Set<string>;
}

/** The shared all-providers-down decision (#3235): down with `earliestResetAt` re-queues (#3226), down without parks. */
export async function allProvidersDown(stage: GateStage, deps: StageBlockedDeps): Promise<AllProvidersDownResult> {
  const gate = await stageBlocked(stage, deps);
  return {
    down: gate.blocked,
    providers: gate.open,
    skip: gate.skip,
    ...(gate.nextAvailableAt ? { earliestResetAt: gate.nextAvailableAt } : {}),
  };
}

/** The park message for an `all_providers_down` park: stage, each provider with its reason, and how to clear it. */
export function allProvidersDownMessage(down: NonNullable<StageGateVerdict['down']>, issue: number): string {
  const list = down.providers
    .map((p) => {
      const until =
        p.until === 'credentials-change' ? ', until credentials change' : p.until ? `, until ${p.until}` : '';
      return `${p.provider} (${p.reason}${until})`;
    })
    .join(', ');
  const metered = down.detail === 'only_metered_left' ? ' The remaining providers are metered and are never used.' : '';
  return `every ${down.stage.toUpperCase()} provider is down with no known reset (${down.detail}): ${list} — no model call; parking #${issue}.${metered} Clear it with \`factory breaker reset <provider>\` or fix the provider credentials.`;
}

/** The one `all_providers_down` event payload for a park; `nextAvailableAt` is null because no reset is known. */
export function allProvidersDownPayload(
  down: NonNullable<StageGateVerdict['down']>,
  issue: number,
): AllProvidersDownPayload {
  return { ...down, nextAvailableAt: null, issue, at: new Date().toISOString() };
}

/** The `all_providers_down` payload for a release to queued (#3340): `nextAvailableAt` is the earliest reset. */
export function allProvidersDownReleasePayload(
  stage: GateStage,
  providers: ProviderDown[],
  earliestResetAt: string,
  issue: number,
  now: () => number = Date.now,
): AllProvidersDownPayload {
  const detail: AllProvidersDownReleaseDetail = providers.every((p) =>
    TIMED_BREAKER_REASONS.has(p.reason as FailoverReason),
  )
    ? 'all_capped'
    : 'reset_pending';
  return { stage, providers, detail, nextAvailableAt: earliestResetAt, issue, at: new Date(now()).toISOString() };
}

/** What the lane watches after the park: the breaker-open providers, never the metered ones. */
export function providersDownOf(down: NonNullable<StageGateVerdict['down']>): NonNullable<ParkedProvidersDown> {
  return { ...down, providers: down.providers.filter((p) => p.reason !== 'metered').map((p) => p.provider) };
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
  /** Every provider is down and no reset is known: park `all_providers_down` (#3235). */
  down?: { stage: GateStage; providers: ProviderDown[]; detail: AllProvidersDownDetail };
}

/** The slice of a run request the gate reads. */
export interface GateRequest {
  issue: number;
  branch: string;
  codexDisabled: boolean;
  failover: { enabled: boolean };
  modelPins: { plan?: string; planFallback?: string; buildFallback?: string };
  /** models.providerOrder (#3338): when set, each stage counts the order's providers for its role (#3340). */
  providerOrder?: ProviderOrder;
  /** A repo-pinned build route: keeps BUILD on its route candidates even under providerOrder. */
  preferredRoute?: BuildRoute;
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
  probe?: ProviderProbe,
) {
  const { issue, branch } = request;
  const order = request.providerOrder;
  const failoverEnabled = request.failover.enabled || order !== undefined;
  let current: { stage: GateStage; candidates: string[] } | undefined;
  const decide = (stage: GateStage, gate: AllProvidersDownResult, route: BuildRoute | undefined): StageGateVerdict => {
    if (!gate.down) return { skip: gate.skip };
    const providers = gate.providers.map((p) => p.provider);
    if (!gate.earliestResetAt) {
      return { skip: gate.skip, down: { stage, providers: gate.providers, detail: 'untimed_breakers' } };
    }
    log(
      'provider-cap-released',
      `every ${stage.toUpperCase()} provider is capped (${providers.join(', ')}) — no model call, releasing #${issue} to queued until ${gate.earliestResetAt}`,
    );
    const released: RunOutcome = {
      state: 'released',
      reason: 'provider-cap',
      route,
      branch,
      reworkRounds: 0,
      providers,
      resetAt: gate.earliestResetAt,
      allProvidersDown: allProvidersDownReleasePayload(stage, gate.providers, gate.earliestResetAt, issue),
    };
    return { skip: gate.skip, released };
  };
  const enter = async (
    stage: GateStage,
    candidates: string[],
    route: BuildRoute | undefined,
    stageLog?: GateLog,
  ): Promise<StageGateVerdict> => {
    current = { stage, candidates };
    // probe past-due earlier providers before the gate's status() reads can time-close them (#3339)
    if (order && probe) await probeDueProviders({ router, breaker, probe, log }, order, stage);
    return decide(
      stage,
      await allProvidersDown(stage, { router, breaker, candidates, failoverEnabled, log: stageLog }),
      route,
    );
  };
  return {
    /** CHECK has no boundary gate (BUILD just succeeded); record it for the catch path. */
    watchCheck(route: BuildRoute, model: string | undefined): void {
      current = { stage: 'check', candidates: order ? order[STAGE_ROLE.check] : buildCandidates(router, route, model) };
    },
    enterPlan(route: BuildRoute | undefined, stageLog: GateLog): Promise<StageGateVerdict> {
      return enter('plan', order ? order[STAGE_ROLE.plan] : planCandidates(router, request.modelPins), route, stageLog);
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
      const candidates =
        order && request.preferredRoute === undefined
          ? order[STAGE_ROLE.build]
          : buildCandidates(router, buildRoute, model, ladder);
      return enter('build', candidates, route);
    },
    async afterFailure(
      err: unknown,
      failurePhase: FailurePhase,
      route: BuildRoute | undefined,
    ): Promise<StageGateVerdict | undefined> {
      const failure = routerFailureOf(err);
      if (!failure || !PROVIDER_LEVEL_REASONS.has(failure.reason)) return undefined;
      const meteredLeft = failure.detail === 'only_metered_left';
      if (failure.detail !== undefined && !meteredLeft) return undefined;
      if (!current || failurePhase === 'ship') return undefined;
      const { stage, candidates } = current;
      try {
        const gate = await allProvidersDown(stage, { router, breaker, candidates, failoverEnabled });
        if (!meteredLeft) {
          const verdict = decide(stage, gate, route);
          return verdict.released || verdict.down ? verdict : undefined;
        }
        const known = new Set(gate.providers.map((p) => p.provider));
        const metered = [
          ...new Set(
            candidates.map((id) => router.registryRef.get(id)?.provider).filter((p): p is string => Boolean(p)),
          ),
        ]
          .filter((provider) => !known.has(provider))
          .map((provider): ProviderDown => ({ provider, reason: 'metered', until: null }));
        return {
          skip: new Set(),
          down: { stage, providers: [...gate.providers, ...metered], detail: 'only_metered_left' },
        };
      } catch (e) {
        // an unreadable breaker must not change how the failure parks, but it must be visible
        log('environment_warning', `provider-cap check failed: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
    },
  };
}
