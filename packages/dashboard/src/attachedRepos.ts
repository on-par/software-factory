// src/attachedRepos.ts — Reads back the repos factoryd has durably attached (~/.factory/registry.json,
// via GET /repos) so a page reload doesn't lose a repo attached at runtime (#1403). `App.tsx`'s
// VITE_FACTORY_REPOS is build-time config and by construction can't see a runtime attach; this is
// the one-shot network read that fills that gap. See the ADR shipped with this change for why this
// stays a one-shot read rather than a poll or a stream, unlike lane state (ADR-0038/ADR-0039).
import { useEffect, useState } from 'react';

interface RepoListing {
  slug: string;
  state: string;
}

export const DEFAULT_REPOS_URL = '/repos';

/** Pure: the slugs of every registry entry still `active`. Paused/draining/detached entries are
 *  not live attachments and are excluded. */
export function activeRepoSlugs(repos: readonly RepoListing[]): string[] {
  return repos.filter((r) => r.state === 'active').map((r) => r.slug);
}

/** Pure: merges the build-time configured slugs with the freshly-fetched active slugs, ordered
 *  and de-duplicated — configured slugs keep their configured order (so idle-repo rendering in
 *  `groupLanesByRepo` stays stable), and any fetched slug not already configured is appended in
 *  the order the registry returned it. */
export function mergeAttachedRepos(configured: readonly string[], fetched: readonly string[]): string[] {
  const seen = new Set(configured);
  const merged = [...configured];
  for (const slug of fetched) {
    if (!seen.has(slug)) {
      seen.add(slug);
      merged.push(slug);
    }
  }
  return merged;
}

export interface FetchAttachedReposDeps {
  fetch?: typeof globalThis.fetch;
  url?: string;
}

/** Fails soft: a network error, a non-OK response, or an unparseable body all resolve to `[]`
 *  rather than throwing, since a reachable factoryd is not guaranteed (e.g. the daemon isn't
 *  running yet) and the caller falls back to the configured list either way. */
export async function fetchAttachedRepos(deps: FetchAttachedReposDeps = {}): Promise<string[]> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  try {
    const res = await fetchFn(deps.url ?? DEFAULT_REPOS_URL);
    if (!res.ok) return [];
    const body = (await res.json()) as { repos?: unknown };
    if (!Array.isArray(body.repos)) return [];
    return activeRepoSlugs(body.repos as RepoListing[]);
  } catch {
    return [];
  }
}

/** One `GET /repos` on mount, merged with the build-time `configured` slugs. Returns `configured`
 *  immediately (no loading flicker, no flash of an empty board) and updates once the fetch
 *  settles — including settling to just `configured` again if factoryd is unreachable. */
export function useAttachedRepos(configured: readonly string[], deps: FetchAttachedReposDeps = {}): string[] {
  const [repos, setRepos] = useState<string[]>(() => [...configured]);

  useEffect(() => {
    let cancelled = false;
    void fetchAttachedRepos(deps).then((fetched) => {
      if (!cancelled) setRepos(mergeAttachedRepos(configured, fetched));
    });
    return () => {
      cancelled = true;
    };
    // Exactly one fetch on mount by design (see module doc comment) — `configured` is a
    // module-level constant built once from build-time env, so it never legitimately changes
    // between renders.
  }, []);

  return repos;
}
