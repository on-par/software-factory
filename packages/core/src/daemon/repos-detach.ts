// src/daemon/repos-detach.ts — The detach gate for factoryd's repo registry:
// takes a repo out of the dispatch set immediately by writing `draining`, waits
// for any in-flight lane to reach a safe RunStatus boundary, then writes the
// `detached` tombstone into ~/.factory/registry.json. `force` skips the wait
// and tombstones the entry at once, accepting that a running lane and its
// worktree may be orphaned. Neither path touches the target repo's own
// `.factory/` directory (#780, epic #761).

import { getRepo, loadRegistry, type RepoRegistryListing, upsertRepo, writeRegistry } from './registry.js';
import type { RunStatus } from '../types/index.js';

/** The RunStatuses a lane may be stopped at without corrupting in-flight work.
 *  Deliberately an allow-list: any status not named here — including any added
 *  to RunStatus later — counts as in-flight and blocks a drain. */
export const SAFE_DETACH_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'ready',
  'awaiting-review',
  'parked',
  'escalated',
  'merged',
  'failed',
]);

export function isSafeDetachBoundary(status: RunStatus): boolean {
  return SAFE_DETACH_STATUSES.has(status);
}

export type DetachFailureReason = 'unknown-repo' | 'drain-timeout';

export type DetachRepoResult =
  | { ok: true; entry: RepoRegistryListing; forced: boolean }
  | { ok: false; reason: DetachFailureReason; detail: string };

export interface DetachRepoOptions {
  /** Skip the drain wait and tombstone the entry immediately. May orphan a
   *  running lane and its worktree — that is the documented contract. */
  force?: boolean;
  /** The RunStatus of every lane currently running for `slug`. Defaults to
   *  reporting none: factoryd does not yet run a dispatch loop in-process, so
   *  the loop story injects the real reader here. */
  readLaneStatuses?: (slug: string) => Promise<RunStatus[]>;
  /** Injectable clock/sleep so the poll is deterministic in tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Default 2_000. */
  pollIntervalMs?: number;
  /** Default 1_800_000 (30 minutes). */
  drainTimeoutMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 30 * 60 * 1_000;
const noLanes = async (): Promise<RunStatus[]> => [];
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The detach gate: takes `slug` out of the dispatch set and, unless forced,
 *  waits for its in-flight lanes to reach a safe boundary before writing the
 *  `detached` tombstone. A slug absent from the registry is `unknown-repo`
 *  with no write; an already-`detached` slug is idempotent with no write.
 *  Neither path reads or writes anything under the target repo's own
 *  `.factory/` directory — the only file written is `registryFile`. */
export async function detachRepo(
  registryFile: string,
  slug: string,
  opts: DetachRepoOptions = {},
): Promise<DetachRepoResult> {
  const registry = await loadRegistry(registryFile);
  const existing = getRepo(registry, slug);

  if (existing === undefined) {
    return { ok: false, reason: 'unknown-repo', detail: `${slug} is not attached` };
  }

  if (existing.state === 'detached') {
    return { ok: true, entry: { slug, ...existing }, forced: false };
  }

  if (opts.force === true) {
    const entry = { ...existing, state: 'detached' as const };
    await writeRegistry(registryFile, upsertRepo(registry, slug, entry));
    return { ok: true, entry: { slug, ...entry }, forced: true };
  }

  if (existing.state !== 'draining') {
    const draining = { ...existing, state: 'draining' as const };
    await writeRegistry(registryFile, upsertRepo(registry, slug, draining));
  }

  const read = opts.readLaneStatuses ?? noLanes;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? realSleep;
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const startedAt = now();
  for (;;) {
    const inFlight = (await read(slug)).filter((s) => !isSafeDetachBoundary(s));
    if (inFlight.length === 0) break;
    if (now() - startedAt >= timeoutMs) {
      return {
        ok: false,
        reason: 'drain-timeout',
        detail:
          `${slug} still has ${inFlight.length} in-flight lane(s) (${inFlight.join(', ')}) ` +
          `after ${timeoutMs}ms; retry with ?force=true to detach without draining`,
      };
    }
    await sleep(pollMs);
  }

  const fresh = await loadRegistry(registryFile);
  const current = getRepo(fresh, slug) ?? { ...existing, state: 'draining' as const };
  const entry = { ...current, state: 'detached' as const };
  await writeRegistry(registryFile, upsertRepo(fresh, slug, entry));

  return { ok: true, entry: { slug, ...entry }, forced: false };
}
