import type { ActiveQueueClaim } from '@on-par/factory-core';
import type { StopSource } from '@on-par/factory-core/internal';
import type { StatusUpdateJson } from './update-state.js';

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

export interface StatusStopInfoJson {
  source: StopSource;
  setAt: string | null;
}

/** `factory status --json` payload (#1101). No queue (#2268) or usage (#2270) section.
 *  Additive changes only; bump schemaVersion on a breaking change. */
export interface StatusJson {
  schemaVersion: 1;
  repo: string;
  product: string | null;
  stop: boolean;
  /** Who set the STOP file and when (#3209, additive); null when no STOP. */
  stopInfo: StatusStopInfoJson | null;
  breaker: StatusBreakerJson;
  active: StatusActiveRowJson[];
  /** factoryd self-update state (#2129, additive); null when no readable update-state.json exists. */
  update: StatusUpdateJson | null;
}

/** Builds the `factory status --json` payload. An unparsable `lastActivityAt` reports `ageSec: 0`, never NaN. */
export function buildStatusJson(input: {
  repo: string;
  product: string | null;
  stop: boolean;
  stopInfo: StatusStopInfoJson | null;
  breakers: ReadonlyArray<{ provider: string; reason: string; openedAt: string; remainingMs: number }>;
  active: ReadonlyArray<Pick<ActiveQueueClaim, 'lane' | 'issue' | 'phase' | 'lastActivityAt'>>;
  update: StatusUpdateJson | null;
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
    stopInfo: input.stopInfo,
    breaker: { open: providers.length > 0, providers },
    active,
    update: input.update,
  };
}
