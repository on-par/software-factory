// src/daemon/repos-attach.ts — The attach precondition gate for factoryd's repo
// registry: validates a `{ repo, path }` request against the checkout on disk
// (its git origin remote must resolve to the posted slug, and it must carry
// .factory/config.json) and only then writes it into ~/.factory/registry.json.
// A rejected attach never touches the registry file (#778, epic #761).

import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { runCommand } from '../utils/command-runner.js';
import { parseRemoteSlug } from './remote-slug.js';
import { loadRegistry, type RepoRegistryListing, upsertRepo, writeRegistry } from './registry.js';

export { parseRemoteSlug } from './remote-slug.js';

/** A POST /repos request body once validated. */
export interface AttachRepoRequest {
  /** GitHub slug, `owner/name`, as posted. */
  repo: string;
  /** Absolute path to the local checkout, as posted. */
  path: string;
}

export type AttachFailureReason =
  'invalid-request' | 'not-a-git-checkout' | 'origin-mismatch' | 'missing-factory-config';

export type AttachRepoResult =
  { ok: true; entry: RepoRegistryListing } | { ok: false; reason: AttachFailureReason; detail: string };

/** Injectable seams — production callers pass nothing. They exist so the HTTP
 *  suite never has to build a real checkout and so attachedAt is deterministic. */
export interface AttachRepoDeps {
  readOrigin?: (dir: string) => Promise<string | null>;
  fileExists?: (file: string) => Promise<boolean>;
  now?: () => Date;
}

const SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** The default `readOrigin` seam: `git -C <dir> remote get-url origin`. Using
 *  `-C` rather than `cwd` means a nonexistent directory is a normal non-zero
 *  exit, not a spawn error. */
export async function readOriginUrl(dir: string): Promise<string | null> {
  const r = await runCommand(['git', '-C', dir, 'remote', 'get-url', 'origin'], { timeoutMs: 5_000 });
  return r.ok ? r.stdout.trim() || null : null;
}

async function defaultFileExists(file: string): Promise<boolean> {
  return stat(file)
    .then((s) => s.isFile())
    .catch(() => false);
}

function parseAttachRequest(body: unknown): { ok: true; request: AttachRepoRequest } | { ok: false; detail: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, detail: 'expected { repo: "owner/name", path: "/abs/path" }' };
  }
  const { repo, path } = body as { repo?: unknown; path?: unknown };
  if (typeof repo !== 'string' || typeof path !== 'string') {
    return { ok: false, detail: 'expected { repo: "owner/name", path: "/abs/path" }' };
  }
  if (!SLUG_RE.test(repo)) {
    return { ok: false, detail: `repo must be an "owner/name" slug, got ${JSON.stringify(repo)}` };
  }
  if (!isAbsolute(path)) {
    return { ok: false, detail: 'path must be absolute' };
  }
  return { ok: true, request: { repo, path } };
}

/** The attach gate, in this exact order, with no registry access until every
 *  check has passed. A rejected attach performs no read-modify-write of the
 *  registry at all. */
export async function attachRepo(
  registryFile: string,
  body: unknown,
  deps: AttachRepoDeps = {},
): Promise<AttachRepoResult> {
  const parsed = parseAttachRequest(body);
  if (!parsed.ok) {
    return { ok: false, reason: 'invalid-request', detail: parsed.detail };
  }
  const { request } = parsed;
  const dir = resolve(request.path);

  const origin = await (deps.readOrigin ?? readOriginUrl)(dir);
  if (origin === null) {
    return { ok: false, reason: 'not-a-git-checkout', detail: `${dir} is not a git checkout with an origin remote` };
  }

  const slug = parseRemoteSlug(origin);
  if (slug === null) {
    return {
      ok: false,
      reason: 'not-a-git-checkout',
      detail: `origin remote "${origin}" does not parse to owner/name`,
    };
  }

  if (slug.toLowerCase() !== request.repo.toLowerCase()) {
    return { ok: false, reason: 'origin-mismatch', detail: `origin is ${slug}, not ${request.repo}` };
  }

  const configFile = join(dir, '.factory', 'config.json');
  const hasConfig = await (deps.fileExists ?? defaultFileExists)(configFile);
  if (!hasConfig) {
    return { ok: false, reason: 'missing-factory-config', detail: `${configFile} not found` };
  }

  const attachedAt = (deps.now?.() ?? new Date()).toISOString();
  const entry = { path: dir, attachedAt, state: 'active' as const };
  const registry = await loadRegistry(registryFile);
  await writeRegistry(registryFile, upsertRepo(registry, request.repo, entry));

  return { ok: true, entry: { slug: request.repo, ...entry } };
}
