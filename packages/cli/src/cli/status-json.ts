import type { ActiveQueueClaim } from '@on-par/factory-core';
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
  const providers: StatusBreakerProviderJson[] = input.breakers.map((b) => ({
    provider: b.provider,
    reason: b.reason,
    openedAt: b.openedAt,
    remainingSec: Math.ceil(b.remainingMs / 1000),
  }));
  const active: StatusActiveRowJson[] = input.active.map((c) => {
    const ageSec = Math.floor((input.now - Date.parse(c.lastActivityAt)) / 1000);
    return { lane: c.lane, issue: c.issue, phase: c.phase, ageSec: Number.isFinite(ageSec) ? Math.max(0, ageSec) : 0 };
  });
  const breaker: StatusBreakerJson = { open: providers.length > 0, providers };
  return {
    schemaVersion: 1,
    repo: input.repo,
    product: input.product,
    stop: input.stop,
    stopInfo: input.stopInfo,
    breaker,
    active,
    update: input.update,
  };
}
