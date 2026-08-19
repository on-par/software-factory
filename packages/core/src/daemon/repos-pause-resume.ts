// src/daemon/repos-pause-resume.ts — The pause/resume state-toggle gate for
// factoryd's repo registry: flips an existing entry's `state` between
// `active` and `paused` in ~/.factory/registry.json, preserving `path` and
// `attachedAt`. A `detached` tombstone is never revived here — re-entering
// dispatch after a detach requires a fresh POST /repos (#779, epic #761).

import {
  getRepo,
  loadRegistry,
  type RepoRegistryListing,
  type RepoState,
  upsertRepo,
  writeRegistry,
} from './registry.js';

/** The two states an operator can set through pause/resume. `detached` is a
 *  tombstone written by detach, never reachable from these routes. */
export type SettableRepoState = Extract<RepoState, 'active' | 'paused'>;

export type SetRepoStateFailureReason = 'unknown-repo' | 'detached';

export type SetRepoStateResult =
  { ok: true; entry: RepoRegistryListing } | { ok: false; reason: SetRepoStateFailureReason; detail: string };

/** The pause/resume gate: sets `slug`'s state to `state`, with no write on
 *  any rejection. A slug absent from the registry is `unknown-repo`; a
 *  `detached` tombstone is rejected rather than revived (see the ADR shipped
 *  with this change). Idempotent within the live states. */
export async function setRepoState(
  registryFile: string,
  slug: string,
  state: SettableRepoState,
): Promise<SetRepoStateResult> {
  const registry = await loadRegistry(registryFile);
  const existing = getRepo(registry, slug);

  if (existing === undefined) {
    return { ok: false, reason: 'unknown-repo', detail: `${slug} is not attached` };
  }

  if (existing.state === 'detached') {
    return { ok: false, reason: 'detached', detail: `${slug} is detached; re-attach it with POST /repos` };
  }

  const entry = { ...existing, state };
  await writeRegistry(registryFile, upsertRepo(registry, slug, entry));

  return { ok: true, entry: { slug, ...entry } };
}
