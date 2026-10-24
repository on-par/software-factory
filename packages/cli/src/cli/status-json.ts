import type { ActiveQueueClaim } from '@on-par/factory-core';
import { providerPlan, TIMED_BREAKER_REASONS } from '@on-par/factory-core/internal';
import type { OpenFactoryDrafts } from '@on-par/factory-core/internal';

import type { StatusJson } from './json-contract.js';
import type { StatusUpdateJson } from './update-state.js';

export type { StatusJson } from './json-contract.js';

/** One open provider in `factory status --json` (#1101). */
export type StatusBreakerProviderJson = StatusJson['breaker']['providers'][number];

/** Provider breaker state (state/breaker.json). `open` is true iff any provider is still open. */
export type StatusBreakerJson = StatusJson['breaker'];

/** One fresh-heartbeat local queue claim. */
export type StatusActiveRowJson = StatusJson['active'][number];

export type StatusStopInfoJson = NonNullable<StatusJson['stopInfo']>;

/** One configured provider with its plan and breaker state (#3236). */
export type StatusProviderJson = StatusJson['providers'][number];

/** One alert that holds right now, derived from breaker state (#3236). */
export type StatusAlertJson = StatusJson['activeAlerts'][number];

type PlanKind = 'subscription' | 'api' | 'unknown';
type StageName = 'plan' | 'build';
interface RegistryModel {
  provider?: string;
  harness?: string;
  providerModel?: string;
  endpoint?: string;
}

/** Providers in the models registry (with plan) and the providers each stage may use, for `status --json` (#3236).
 *  Mirrors stageBlocked's model-id to distinct-provider mapping; failover off counts only a stage's first provider. */
export function statusProviderInputs(
  router: {
    registryRef: { list(): string[]; get(id: string): RegistryModel | undefined };
    resolveAll(task: 'plan' | 'build_claude' | 'build_codex'): string[];
  },
  opts: { failoverEnabled: boolean; plan?: (provider: string, model: RegistryModel | undefined) => PlanKind },
): { providers: { id: string; plan: PlanKind }[]; stages: { stage: StageName; providers: string[] }[] } {
  const planOf = opts.plan ?? providerPlan;
  const first = new Map<string, RegistryModel>();
  for (const id of router.registryRef.list()) {
    const def = router.registryRef.get(id);
    if (def?.provider && !first.has(def.provider)) first.set(def.provider, def);
  }
  const providers = [...first].map(([id, def]) => ({ id, plan: planOf(id, def) }));
  const stageProviders = (ids: string[]): string[] => {
    const all = [
      ...new Set(ids.map((id) => router.registryRef.get(id)?.provider).filter((p): p is string => Boolean(p))),
    ];
    return opts.failoverEnabled ? all : all.slice(0, 1);
  };
  return {
    providers,
    stages: [
      { stage: 'plan', providers: stageProviders(router.resolveAll('plan')) },
      {
        stage: 'build',
        providers: stageProviders([...router.resolveAll('build_claude'), ...router.resolveAll('build_codex')]),
      },
    ],
  };
}

/** Builds the `factory status --json` payload. An unparsable `lastActivityAt` reports `ageSec: 0`, never NaN. */
export function buildStatusJson(input: {
  repo: string;
  product: string | null;
  stop: boolean;
  stopInfo: StatusStopInfoJson | null;
  breakers: ReadonlyArray<{
    provider: string;
    reason: string;
    openedAt: string;
    remainingMs: number;
    until?: 'credentials-change';
  }>;
  providers?: ReadonlyArray<{ id: string; plan: PlanKind }>;
  stages?: ReadonlyArray<{ stage: StageName; providers: readonly string[] }>;
  active: ReadonlyArray<Pick<ActiveQueueClaim, 'lane' | 'issue' | 'phase' | 'lastActivityAt'>>;
  update: StatusUpdateJson | null;
  openFactoryDrafts: OpenFactoryDrafts | null;
  now: number;
}): StatusJson {
  const breakerProviders: StatusBreakerProviderJson[] = input.breakers.map((b) => ({
    provider: b.provider,
    reason: b.reason,
    openedAt: b.openedAt,
    remainingSec: Number.isFinite(b.remainingMs) ? Math.ceil(b.remainingMs / 1000) : 0,
    ...(b.until ? { until: b.until } : {}),
  }));
  const active: StatusActiveRowJson[] = input.active.map((c) => {
    const ageSec = Math.floor((input.now - Date.parse(c.lastActivityAt)) / 1000);
    return { lane: c.lane, issue: c.issue, phase: c.phase, ageSec: Number.isFinite(ageSec) ? Math.max(0, ageSec) : 0 };
  });
  const breaker: StatusBreakerJson = { open: breakerProviders.length > 0, providers: breakerProviders };
  const providers: StatusProviderJson[] = (input.providers ?? []).map((p) => {
    const b = input.breakers.find((x) => x.provider === p.id);
    if (!b) return { id: p.id, plan: p.plan, breaker: 'closed', openedReason: null, openedAt: null };
    return {
      id: p.id,
      plan: p.plan,
      breaker: 'open',
      openedReason: b.reason,
      openedAt: b.openedAt,
      ...(Number.isFinite(b.remainingMs) ? { resetAt: new Date(input.now + b.remainingMs).toISOString() } : {}),
    };
  });
  const activeAlerts: StatusAlertJson[] = [];
  for (const b of input.breakers) {
    if (b.until !== 'credentials-change') continue;
    activeAlerts.push({
      kind: 'provider_auth_rejected',
      provider: b.provider,
      since: b.openedAt,
      detail: `${b.provider} rejected its credentials (${b.reason}); fix the credentials or run factory breaker reset ${b.provider}`,
    });
  }
  for (const s of input.stages ?? []) {
    if (s.providers.length === 0) continue;
    const open = input.breakers.filter((b) => s.providers.includes(b.provider));
    if (open.length !== s.providers.length) continue;
    if (
      open.some((b) => (TIMED_BREAKER_REASONS as ReadonlySet<string>).has(b.reason) && Number.isFinite(b.remainingMs))
    )
      continue;
    activeAlerts.push({
      kind: 'all_providers_down',
      stage: s.stage,
      since: open.map((b) => b.openedAt).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)),
      detail: `every ${s.stage.toUpperCase()} provider is down with no known reset: ${open.map((b) => `${b.provider} (${b.reason})`).join(', ')}`,
    });
  }
  return {
    schemaVersion: 1,
    repo: input.repo,
    product: input.product,
    stop: input.stop,
    stopInfo: input.stopInfo,
    breaker,
    active,
    update: input.update,
    openFactoryDrafts: input.openFactoryDrafts,
    providers,
    activeAlerts,
  };
}
