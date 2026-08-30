// src/usage/coordinator.ts — Single-poller cached subscription-usage snapshot (#1029)
// and admission-control acquire() API backed by a shared grant ledger (#1030).

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { FactoryLogger } from '../logger/index.js';
import { withFileLock } from '../utils/lock.js';
import type { AcquireResult, GrantLedgerEntry, GrantRequest } from './grant-ledger.js';
import {
  defaultGrantLedgerPath,
  DEFAULT_GRANT_TTL_MS,
  isCappedModel,
  loadGrantLedger,
  pruneGrants,
  USAGE_ADMISSION_CEILING_PCT,
  USAGE_GRANT_RESERVATION_PCT,
  writeGrantLedger,
} from './grant-ledger.js';
import { DEFAULT_USAGE_POLL_MS } from './constants.js';
import type { SubscriptionUsage, SubscriptionUsageDeps } from './subscription.js';
import { fetchSubscriptionUsage } from './subscription.js';

export { DEFAULT_USAGE_POLL_MS };

export interface UsageCoordinatorState {
  version: 1;
  snapshot: SubscriptionUsage | null;
  fetchedAt: string | null;
}

export interface WriteUsageStateOptions {
  writeFile?: (file: string, data: string) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
}

export interface UsageCoordinatorOptions {
  statePath: string;
  logger: FactoryLogger;
  pollMs?: number;
  subscriptionDeps?: SubscriptionUsageDeps;
  fetchSubscription?: () => Promise<SubscriptionUsage | null>;
  now?: () => number;
  writeState?: (file: string, state: UsageCoordinatorState) => Promise<void>;
  grantsPath?: string;
  admissionCeilingPct?: number;
  grantReservationPct?: number;
  grantTtlMs?: number;
  withLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  randomId?: () => string;
}

export interface UsageCoordinator {
  start(): Promise<void>;
  stop(): void;
  pollNow(): Promise<SubscriptionUsage | null>;
  read(): SubscriptionUsage | null;
  acquire(request: GrantRequest): Promise<AcquireResult>;
}

export function defaultUsageStatePath(home?: string): string {
  return join(home ?? homedir(), '.factory', 'usage', 'coordinator.json');
}

function emptyUsageState(): UsageCoordinatorState {
  return { version: 1, snapshot: null, fetchedAt: null };
}

function isSnapshot(value: unknown): value is SubscriptionUsage {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<SubscriptionUsage>;
  return (
    typeof s.fiveHourUtilization === 'number' && (s.fiveHourResetsAt === null || typeof s.fiveHourResetsAt === 'string')
  );
}

/** Reads the persisted coordinator state. A missing file, unparsable JSON, or a
 *  non-object payload all yield empty state — this NEVER throws and NEVER
 *  creates the file. A malformed `snapshot` drops to `null`; a malformed
 *  `fetchedAt` drops to `null`. */
export async function loadUsageState(file: string): Promise<UsageCoordinatorState> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch {
    return emptyUsageState();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyUsageState();
  }
  if (!parsed || typeof parsed !== 'object') return emptyUsageState();
  const candidate = parsed as { snapshot?: unknown; fetchedAt?: unknown };
  const snapshot = isSnapshot(candidate.snapshot)
    ? {
        fiveHourUtilization: candidate.snapshot.fiveHourUtilization,
        fiveHourResetsAt: candidate.snapshot.fiveHourResetsAt,
      }
    : null;
  const fetchedAt = typeof candidate.fetchedAt === 'string' ? candidate.fetchedAt : null;
  return { version: 1, snapshot, fetchedAt };
}

/** Atomic write: mkdir the parent, serialize to `${file}.tmp`, then rename it
 *  onto `file`. Mirrors `writeRegistry` in `daemon/registry.ts`. */
export async function writeUsageState(
  file: string,
  state: UsageCoordinatorState,
  opts: WriteUsageStateOptions = {},
): Promise<void> {
  const write = opts.writeFile ?? ((f: string, data: string) => writeFile(f, data));
  const move = opts.rename ?? ((from: string, to: string) => rename(from, to));
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await write(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await move(tmp, file);
}

function validatePollMs(options: UsageCoordinatorOptions): number {
  const pollMs = options.pollMs ?? DEFAULT_USAGE_POLL_MS;
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new RangeError('Usage coordinator poll interval must be positive');
  return pollMs;
}

export function createUsageCoordinator(options: UsageCoordinatorOptions): UsageCoordinator {
  const pollMs = validatePollMs(options);
  const { statePath, logger } = options;
  const fetchSubscription = options.fetchSubscription ?? (() => fetchSubscriptionUsage(options.subscriptionDeps ?? {}));
  const now = options.now ?? options.subscriptionDeps?.now ?? Date.now;
  const writeState = options.writeState ?? ((f: string, s: UsageCoordinatorState) => writeUsageState(f, s));
  const grantsPath = options.grantsPath ?? defaultGrantLedgerPath();
  const admissionCeilingPct = options.admissionCeilingPct ?? USAGE_ADMISSION_CEILING_PCT;
  const grantReservationPct = options.grantReservationPct ?? USAGE_GRANT_RESERVATION_PCT;
  const grantTtlMs = options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS;
  const randomId = options.randomId ?? randomUUID;
  const withLock = options.withLock ?? (<T>(fn: () => Promise<T>) => withFileLock(`${grantsPath}.lock`, fn));

  let cachedSnapshot: SubscriptionUsage | null = null;
  let interval: ReturnType<typeof setInterval> | undefined;
  let started = false;
  let inFlight: Promise<SubscriptionUsage | null> | undefined;

  async function refresh(): Promise<SubscriptionUsage | null> {
    try {
      const result = await fetchSubscription();
      if (result !== null) {
        cachedSnapshot = result;
        await writeState(statePath, { version: 1, snapshot: result, fetchedAt: new Date(now()).toISOString() });
        logger.info('usage_coordinator_poll_succeeded', 'Usage coordinator poll succeeded', {
          actor: 'daemon/usage-coordinator',
        });
      } else {
        logger.warn('usage_coordinator_poll_empty', 'Usage coordinator poll returned no snapshot', {
          actor: 'daemon/usage-coordinator',
        });
      }
      return cachedSnapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('usage_coordinator_poll_failed', `Usage coordinator poll failed: ${message}`, {
        actor: 'daemon/usage-coordinator',
      });
      return cachedSnapshot;
    }
  }

  function pollNow(): Promise<SubscriptionUsage | null> {
    if (inFlight !== undefined) return inFlight;
    inFlight = refresh().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  async function start(): Promise<void> {
    started = true;
    const persisted = await loadUsageState(statePath);
    if (cachedSnapshot === null) cachedSnapshot = persisted.snapshot;
    await pollNow();
    if (started && interval === undefined) {
      interval = setInterval(() => {
        void pollNow();
      }, pollMs);
    }
  }

  function stop(): void {
    started = false;
    if (interval !== undefined) clearInterval(interval);
    interval = undefined;
  }

  function read(): SubscriptionUsage | null {
    return cachedSnapshot === null ? null : { ...cachedSnapshot };
  }

  async function acquire(request: GrantRequest): Promise<AcquireResult> {
    return withLock(async () => {
      const snapshot = cachedSnapshot;
      const at = now();
      const retryAfter = (): number => {
        const resetsAt = snapshot?.fiveHourResetsAt;
        if (!resetsAt) return pollMs;
        const t = Date.parse(resetsAt);
        return Number.isNaN(t) ? pollMs : Math.max(0, t - at);
      };

      // Non-Claude routes are not gated on the subscription cap.
      if (!isCappedModel(request.model)) return { granted: true };

      // No usage signal yet: deny conservatively rather than admit blind.
      if (snapshot === null) return { granted: false, retryAfter: pollMs };

      const ledger = await loadGrantLedger(grantsPath);
      const outstanding = pruneGrants(ledger.grants, at, grantTtlMs);
      const reserved = outstanding.reduce((sum, g) => sum + g.reservationPct, 0);
      const projected = snapshot.fiveHourUtilization + reserved + grantReservationPct;

      if (projected > admissionCeilingPct) {
        await writeGrantLedger(grantsPath, { version: 1, grants: outstanding });
        return { granted: false, retryAfter: retryAfter() };
      }

      const entry: GrantLedgerEntry = {
        id: randomId(),
        repo: request.repo,
        lane: request.lane,
        phase: request.phase,
        model: request.model,
        grantedAt: new Date(at).toISOString(),
        reservationPct: grantReservationPct,
      };
      await writeGrantLedger(grantsPath, { version: 1, grants: [...outstanding, entry] });
      return { granted: true };
    });
  }

  return { start, stop, pollNow, read, acquire };
}
