// src/usage/local-coordinator.ts — Standalone single-repo UsageCoordinator fallback (#1033).
//
// A standalone `factory run` (no daemon) has no shared grant ledger and no cross-repo
// admission arbiter, so this IS the coordinator in standalone mode: it owns the direct
// fetchSubscriptionUsage call itself (ADR-0066 is preserved because the engine still
// consults a UsageCoordinator, never fetchSubscriptionUsage directly). It holds no grant
// ledger, no persistent coordinator.json, and runs no setInterval poll loop.

import type { UsageCoordinator } from './coordinator.js';
import { DEFAULT_USAGE_POLL_MS } from './constants.js';
import type { AcquireResult, GrantRequest } from './grant-ledger.js';
import { isCappedModel, USAGE_ADMISSION_CEILING_PCT, USAGE_GRANT_RESERVATION_PCT } from './grant-ledger.js';
import type { SubscriptionUsage, SubscriptionUsageDeps } from './subscription.js';
import { fetchSubscriptionUsage } from './subscription.js';

export interface LocalUsageCoordinatorOptions {
  subscriptionDeps?: SubscriptionUsageDeps;
  fetchSubscription?: () => Promise<SubscriptionUsage | null>;
  now?: () => number;
  pollMs?: number;
  admissionCeilingPct?: number;
  grantReservationPct?: number;
}

export function createLocalUsageCoordinator(options: LocalUsageCoordinatorOptions = {}): UsageCoordinator {
  const fetchSubscription = options.fetchSubscription ?? (() => fetchSubscriptionUsage(options.subscriptionDeps ?? {}));
  const now = options.now ?? options.subscriptionDeps?.now ?? Date.now;
  const pollMs = options.pollMs ?? DEFAULT_USAGE_POLL_MS;
  const admissionCeilingPct = options.admissionCeilingPct ?? USAGE_ADMISSION_CEILING_PCT;
  const grantReservationPct = options.grantReservationPct ?? USAGE_GRANT_RESERVATION_PCT;

  let cachedSnapshot: SubscriptionUsage | null = null;

  async function refresh(): Promise<SubscriptionUsage | null> {
    const result = await fetchSubscription();
    if (result !== null) cachedSnapshot = result; // keep last good on a null/failed fetch, mirrors daemon
    return cachedSnapshot;
  }

  async function start(): Promise<void> {
    await refresh();
  }

  function stop(): void {
    // No poll loop or persisted state to tear down.
  }

  function pollNow(): Promise<SubscriptionUsage | null> {
    return refresh();
  }

  function read(): SubscriptionUsage | null {
    return cachedSnapshot === null ? null : { ...cachedSnapshot };
  }

  async function acquire(request: GrantRequest): Promise<AcquireResult> {
    if (!isCappedModel(request.model)) return { granted: true };

    const snapshot = await refresh();
    // Unavailable signal: a standalone sole engine is never blocked on a missing signal.
    if (snapshot === null) return { granted: true };

    const projected = snapshot.fiveHourUtilization + grantReservationPct;
    if (projected > admissionCeilingPct) {
      const at = now();
      const t = snapshot.fiveHourResetsAt ? Date.parse(snapshot.fiveHourResetsAt) : NaN;
      const retryAfter = Number.isNaN(t) ? pollMs : Math.max(0, t - at);
      return { granted: false, retryAfter };
    }

    return { granted: true };
  }

  return { start, stop, pollNow, read, acquire };
}
