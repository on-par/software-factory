import type { ActiveQueueClaim } from '@on-par/factory-core';

/** One open provider in `factory status --json` (#1101). */
export interface StatusBreakerProviderJson {
  provider: string;
  reason: string;
  openedAt: string;
  remainingSec: number;
}

/** Provider breaker state (state/breaker.json). `open` is true iff any provider is still open. */
export interface StatusBreakerJson {
  open: boolean;
  providers: StatusBreakerProviderJson[];
}

/** One fresh-heartbeat local queue claim. */
export interface StatusActiveRowJson {
  lane: string;
  issue: number;
  phase: string;
  ageSec: number;
}

/** `factory status --json` payload (#1101). No queue (#2268) or usage (#2270) section.
 *  Additive changes only; bump schemaVersion on a breaking change. */
export interface StatusJson {
  schemaVersion: 1;
  repo: string;
  product: string | null;
  stop: boolean;
  breaker: StatusBreakerJson;
  active: StatusActiveRowJson[];
}

/** Builds the `factory status --json` payload. An unparsable `lastActivityAt` reports `ageSec: 0`, never NaN. */
export function buildStatusJson(input: {
  repo: string;
  product: string | null;
  stop: boolean;
  breakers: ReadonlyArray<{ provider: string; reason: string; openedAt: string; remainingMs: number }>;
  active: ReadonlyArray<Pick<ActiveQueueClaim, 'lane' | 'issue' | 'phase' | 'lastActivityAt'>>;
  now: number;
}): StatusJson {
  const providers = input.breakers.map((b) => ({
    provider: b.provider,
    reason: b.reason,
    openedAt: b.openedAt,
    remainingSec: Math.ceil(b.remainingMs / 1000),
  }));
  const active = input.active.map((c) => {
    const ageSec = Math.floor((input.now - Date.parse(c.lastActivityAt)) / 1000);
    return { lane: c.lane, issue: c.issue, phase: c.phase, ageSec: Number.isFinite(ageSec) ? Math.max(0, ageSec) : 0 };
  });
  return {
    schemaVersion: 1,
    repo: input.repo,
    product: input.product,
    stop: input.stop,
    breaker: { open: providers.length > 0, providers },
    active,
  };
}
