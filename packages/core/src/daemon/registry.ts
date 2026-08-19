// src/daemon/registry.ts — The user-scoped repo registry backing `factoryd`
// (~/.factory/registry.json): which repos the daemon is attached to and what
// state each is in. Load is tolerant (missing/corrupt => empty, never throws);
// write is atomic (tmp file + same-dir rename) so a crash mid-write can never
// replace a good file with a partial one (#781, epic #761).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Attachment state of a repo in the daemon registry. `detached` entries are
 *  retained as tombstones rather than deleted, so a detach is auditable. */
export type RepoState = 'active' | 'paused' | 'detached';

export interface RepoRegistryEntry {
  /** Absolute path to the local checkout. */
  path: string;
  /** ISO-8601 timestamp of the attach that created this entry. */
  attachedAt: string;
  state: RepoState;
}

/** The on-disk shape of ~/.factory/registry.json, keyed by `owner/name` slug. */
export interface RepoRegistry {
  version: 1;
  repos: Record<string, RepoRegistryEntry>;
}

/** One `listRepos` row: the entry plus the slug it is keyed by. */
export interface RepoRegistryListing extends RepoRegistryEntry {
  slug: string;
}

/** Injectable fs seams — production callers pass nothing. They exist so the
 *  mid-write-crash contract is covered by a deterministic test rather than by
 *  killing a real process. */
export interface WriteRegistryOptions {
  writeFile?: (file: string, data: string) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
}

const REPO_STATES = new Set<string>(['active', 'paused', 'detached']);

function isEntry(value: unknown): value is RepoRegistryEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Partial<RepoRegistryEntry>;
  return typeof e.path === 'string' && typeof e.attachedAt === 'string' && REPO_STATES.has(e.state as string);
}

/** `<home>/.factory/registry.json`. `home` defaults to os.homedir() and is
 *  overridable so tests never touch the real home directory. */
export function defaultRegistryPath(home?: string): string {
  return join(home ?? homedir(), '.factory', 'registry.json');
}

export function emptyRegistry(): RepoRegistry {
  return { version: 1, repos: {} };
}

/** Reads the registry file. A missing file, unparsable JSON, or a non-object
 *  payload all yield an empty in-memory registry — this NEVER throws and NEVER
 *  creates the file. Individual malformed entries are dropped; well-formed
 *  siblings survive. */
export async function loadRegistry(file: string): Promise<RepoRegistry> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch {
    return emptyRegistry();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyRegistry();
  }
  if (!parsed || typeof parsed !== 'object') return emptyRegistry();
  const repos: Record<string, RepoRegistryEntry> = {};
  const candidates = (parsed as { repos?: unknown }).repos;
  if (candidates && typeof candidates === 'object') {
    for (const [slug, entry] of Object.entries(candidates as Record<string, unknown>)) {
      if (isEntry(entry)) repos[slug] = { path: entry.path, attachedAt: entry.attachedAt, state: entry.state };
    }
  }
  return { version: 1, repos };
}

/** undefined for an unknown slug; never throws. */
export function getRepo(registry: RepoRegistry, slug: string): RepoRegistryEntry | undefined {
  return registry.repos[slug];
}

/** Every entry as a `{ slug, path, attachedAt, state }` row, sorted ascending
 *  by slug so callers (and tests) see a deterministic order. */
export function listRepos(registry: RepoRegistry): RepoRegistryListing[] {
  return Object.entries(registry.repos)
    .map(([slug, entry]) => ({ slug, ...entry }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Pure: returns a new registry with `slug` set to `entry`. The input registry
 *  is never mutated, so a caller can keep the pre-write value to compare or
 *  roll back to. */
export function upsertRepo(registry: RepoRegistry, slug: string, entry: RepoRegistryEntry): RepoRegistry {
  return { version: 1, repos: { ...registry.repos, [slug]: entry } };
}

/** Atomic write: mkdir the parent, serialize to `${file}.tmp`, then rename it
 *  onto `file`. The rename is the commit point — a crash before it leaves any
 *  previously written `file` byte-for-byte intact, and a crash during it leaves
 *  either the old file or the new one, never a partial. Mirrors
 *  ProviderBreaker.write in src/router/breaker.ts. */
export async function writeRegistry(
  file: string,
  registry: RepoRegistry,
  opts: WriteRegistryOptions = {},
): Promise<void> {
  const write = opts.writeFile ?? ((f: string, data: string) => writeFile(f, data));
  const move = opts.rename ?? ((from: string, to: string) => rename(from, to));
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await write(tmp, `${JSON.stringify(registry, null, 2)}\n`);
  await move(tmp, file);
}
