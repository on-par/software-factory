// src/daemon/repos-detach.ts — The detach gate for factoryd's repo registry:
// beginDetach performs the synchronous registry transition (immediately
// ineligible for new claims), and drainAndDetach is the background loop that
// waits for any in-flight lane to reach a safe RunStatus boundary before
// writing the `detached` tombstone. `force` skips the wait and tombstones the
// entry at once, accepting that a running lane and its worktree may be
// orphaned. Neither function touches the target repo's own `.factory/`
// directory (#780, epic #761).

import { getRepo, loadRegistry, type RepoRegistryListing, upsertRepo, writeRegistry } from './registry.js';
import type { RunStatus } from '../types/index.js';

/** A lane in one of these statuses is actively mutating the checkout and must
 *  not be interrupted. Everything else in RunStatus — pending, ready,
 *  awaiting-review, parked, escalated, merged, failed — is a safe drain
 *  boundary. */
export const DRAIN_BLOCKING_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'planning',
  'building',
  'checking',
  'reworking',
  'shipping',
]);

export function isDrainSafe(statuses: readonly RunStatus[]): boolean {
  return !statuses.some((s) => DRAIN_BLOCKING_STATUSES.has(s));
}

export type BeginDetachResult =
  { ok: true; entry: RepoRegistryListing; draining: boolean } | { ok: false; reason: 'unknown-repo'; detail: string };

/** 'detached' — tombstone written. 'timed-out' — drainTimeoutMs elapsed with a
 *  lane still blocking. 'aborted' — the server stopped mid-drain.
 *  'superseded' — the entry was no longer 'draining' when the loop looked (a
 *  force detach or a re-attach raced ahead). Only 'detached' writes. */
export type DrainOutcome = 'detached' | 'timed-out' | 'aborted' | 'superseded';

/** Injectable seams — production callers pass nothing. */
export interface DetachRepoDeps {
  /** Reports the in-flight lane statuses for the checkout at `repoPath`. The
   *  default reports none, so an unwired factoryd drains immediately; the
   *  daemon engine story injects the real reader. Never writes, and never
   *  touches the checkout's .factory/ directory. */
  readLaneStatuses?: (repoPath: string) => Promise<readonly RunStatus[]>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  drainTimeoutMs?: number;
  /** Cooperative cancellation; the loop checks `.aborted` before each poll and
   *  each sleep. */
  signal?: { aborted: boolean };
}

export const DEFAULT_DRAIN_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_DRAIN_TIMEOUT_MS = 30 * 60_000;

/** The synchronous half of a detach: takes `slug` out of the dispatch set at
 *  once. An unknown slug is `unknown-repo` with no write; an already-detached
 *  slug is idempotent with no write; otherwise writes `detached` (forced) or
 *  `draining` (the default, awaiting drainAndDetach). */
export async function beginDetach(registryFile: string, slug: string, force: boolean): Promise<BeginDetachResult> {
  const registry = await loadRegistry(registryFile);
  const existing = getRepo(registry, slug);

  if (existing === undefined) {
    return { ok: false, reason: 'unknown-repo', detail: `${slug} is not attached` };
  }

  if (existing.state === 'detached') {
    return { ok: true, entry: { slug, ...existing }, draining: false };
  }

  const state = force ? ('detached' as const) : ('draining' as const);
  const entry = { ...existing, state };
  await writeRegistry(registryFile, upsertRepo(registry, slug, entry));
  return { ok: true, entry: { slug, ...entry }, draining: !force };
}

/** The background half of a detach: polls `deps.readLaneStatuses` until the
 *  in-flight lane clears a safe boundary, then writes the `detached`
 *  tombstone. Re-reads the registry every pass so a racing force-detach or
 *  re-attach safely supersedes the loop instead of being overwritten. */
export async function drainAndDetach(
  registryFile: string,
  slug: string,
  deps: DetachRepoDeps = {},
): Promise<DrainOutcome> {
  const read = deps.readLaneStatuses ?? (async () => []);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_DRAIN_POLL_INTERVAL_MS;
  const drainTimeoutMs = deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const deadline = now() + drainTimeoutMs;

  for (;;) {
    if (deps.signal?.aborted === true) return 'aborted';

    const registry = await loadRegistry(registryFile);
    const entry = getRepo(registry, slug);
    if (entry === undefined || entry.state !== 'draining') return 'superseded';

    const statuses = await read(entry.path);
    if (isDrainSafe(statuses)) {
      await writeRegistry(registryFile, upsertRepo(registry, slug, { ...entry, state: 'detached' }));
      return 'detached';
    }

    if (now() >= deadline) return 'timed-out';
    await sleep(pollIntervalMs);
  }
}
