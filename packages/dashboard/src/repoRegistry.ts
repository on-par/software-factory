// src/repoRegistry.ts — Typed browser client for factoryd's repo lifecycle
// control plane (GET /repos, POST /repos/<owner>/<name>/pause|resume, DELETE
// /repos/<owner>/<name>). The dashboard cannot import @on-par/factory-core
// (Node-only, devDependency), so the registry row shape is mirrored locally
// from packages/core/src/daemon/registry.ts rather than shared.

export const DEFAULT_REPOS_URL = '/repos';

/** Mirrors core's RepoState (packages/core/src/daemon/registry.ts). */
export type RepoState = 'active' | 'paused' | 'draining' | 'detached';

/** Mirrors core's RepoRegistryListing — one GET /repos row. */
export interface RepoListing {
  slug: string;
  path: string;
  stateRoot?: string;
  attachedAt: string;
  state: RepoState;
}

export type RepoListResult = { ok: true; repos: RepoListing[] } | { ok: false; error: string };
export type RepoMutationResult = { ok: true; repo: RepoListing } | { ok: false; error: string };

/** Narrow structural port over fetch so tests inject a plain function. */
export type HttpFetch = (
  url: string,
  init?: { method?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface RepoRegistryClientOptions {
  /** Default DEFAULT_REPOS_URL — same-origin, proxied to factoryd in dev. */
  baseUrl?: string;
  /** Default globalThis.fetch. */
  fetch?: HttpFetch;
}

export interface RepoRegistryClient {
  list(): Promise<RepoListResult>;
  pause(slug: string): Promise<RepoMutationResult>;
  resume(slug: string): Promise<RepoMutationResult>;
  detach(slug: string): Promise<RepoMutationResult>;
}

const REPO_STATES = new Set<string>(['active', 'paused', 'draining', 'detached']);

function parseRepoListing(value: unknown): RepoListing | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const e = value as Partial<RepoListing>;
  if (
    typeof e.slug !== 'string' ||
    typeof e.path !== 'string' ||
    (e.stateRoot !== undefined && typeof e.stateRoot !== 'string') ||
    typeof e.attachedAt !== 'string' ||
    !REPO_STATES.has(e.state as string)
  ) {
    return undefined;
  }
  return {
    slug: e.slug,
    path: e.path,
    ...(e.stateRoot === undefined ? {} : { stateRoot: e.stateRoot }),
    attachedAt: e.attachedAt,
    state: e.state as RepoState,
  };
}

function parseListPayload(value: unknown): RepoListing[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const repos = (value as { repos?: unknown }).repos;
  if (!Array.isArray(repos)) return undefined;
  const parsed: RepoListing[] = [];
  for (const row of repos) {
    const entry = parseRepoListing(row);
    if (entry !== undefined) parsed.push(entry);
  }
  return parsed;
}

export function createRepoRegistryClient(options?: RepoRegistryClientOptions): RepoRegistryClient {
  const baseUrl = options?.baseUrl ?? DEFAULT_REPOS_URL;
  const doFetch = options?.fetch ?? ((url, init) => globalThis.fetch(url, init) as ReturnType<HttpFetch>);

  async function request(
    path: string,
    method: string,
  ): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
    let res: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
      res = await doFetch(path, { method });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!res.ok) {
      let error: string | undefined;
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body?.error === 'string') error = body.error;
      } catch {
        // fall through to the status-based message below
      }
      return { ok: false, error: error ?? `factoryd responded ${res.status}` };
    }
    try {
      return { ok: true, body: await res.json() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function list(): Promise<RepoListResult> {
    const result = await request(baseUrl, 'GET');
    if (!result.ok) return result;
    const repos = parseListPayload(result.body);
    if (repos === undefined) return { ok: false, error: 'unexpected response from factoryd' };
    return { ok: true, repos };
  }

  async function mutate(path: string, method: string): Promise<RepoMutationResult> {
    const result = await request(path, method);
    if (!result.ok) return result;
    const repo = parseRepoListing((result.body as { repo?: unknown } | undefined)?.repo);
    if (repo === undefined) return { ok: false, error: 'unexpected response from factoryd' };
    return { ok: true, repo };
  }

  return {
    list,
    pause: (slug) => mutate(`${baseUrl}/${slug}/pause`, 'POST'),
    resume: (slug) => mutate(`${baseUrl}/${slug}/resume`, 'POST'),
    detach: (slug) => mutate(`${baseUrl}/${slug}`, 'DELETE'),
  };
}
