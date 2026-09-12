import { DEFAULT_REPOS_URL } from './repoAttach.js';

/** Mirrors core's RepoState (packages/core/src/daemon/registry.ts). */
export type RepoState = 'active' | 'paused' | 'draining' | 'detached';

/** Mirrors core's RepoRegistryListing — one row of GET /repos. */
export interface AttachedRepo {
  slug: string;
  path: string;
  attachedAt: string;
  state: RepoState;
}

export type RepoListOutcome = { ok: true; repos: AttachedRepo[] } | { ok: false; error: string };

export interface RepoListDeps {
  fetch?: typeof globalThis.fetch;
  url?: string;
}

export const REPO_STATE_LABEL: Record<RepoState, string> = {
  active: 'Active',
  paused: 'Paused',
  draining: 'Draining',
  detached: 'Detached',
};

function isAttachedRepo(value: unknown): value is AttachedRepo {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<AttachedRepo>;
  return (
    typeof row.slug === 'string' &&
    typeof row.path === 'string' &&
    typeof row.attachedAt === 'string' &&
    typeof row.state === 'string' &&
    Object.hasOwn(REPO_STATE_LABEL, row.state)
  );
}

/** Pure and tolerant: a payload that is not an object, or whose `repos` is not an array, yields
 *  `[]`. Malformed rows are dropped and well-formed siblings survive. Sorted ascending by slug,
 *  matching core's `listRepos` order. */
export function parseRepoListing(payload: unknown): AttachedRepo[] {
  if (!payload || typeof payload !== 'object') return [];
  const { repos } = payload as { repos?: unknown };
  if (!Array.isArray(repos)) return [];
  return repos.filter(isAttachedRepo).sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Never throws or rejects: a transport failure, a non-2xx status, or an unparsable body all
 *  resolve to `{ ok: false }` with a message. */
export async function fetchRepos(deps: RepoListDeps = {}): Promise<RepoListOutcome> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchFn(deps.url ?? DEFAULT_REPOS_URL);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!response.ok) return { ok: false, error: `factoryd responded ${response.status}` };

  try {
    const body: unknown = await response.json();
    return { ok: true, repos: parseRepoListing(body) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
