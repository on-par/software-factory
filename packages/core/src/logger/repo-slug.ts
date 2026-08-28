// src/logger/repo-slug.ts — Resolves the emitting checkout's `owner/name` slug for
// FactoryEvent.repo (#971). The logger's write path is synchronous (ADR-0002), so the
// origin read is a spawnSync mirroring daemon/repos-attach.ts's `readOriginUrl` argv,
// piped through daemon/remote-slug.ts's pure `parseRemoteSlug` — the one and only
// parsing site (repos-attach.ts re-exports it for its own callers). Importing the
// leaf module directly, rather than repos-attach.ts, keeps `execa` (pulled in by
// repos-attach.ts's own `readOriginUrl` via utils/command-runner.ts) out of every
// FactoryLogger construction's module graph. Memoized per directory, including
// negative results: a hot log loop spawns no git.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { parseRemoteSlug } from '../daemon/remote-slug.js';

const ORIGIN_TIMEOUT_MS = 5_000;

/** Memo of dir -> slug, including negative (null) results. */
const cache = new Map<string, string | null>();

/** Test seam: drops the memo so a suite can re-resolve a directory it just changed. */
export function clearRepoSlugCache(): void {
  cache.clear();
}

/** Nearest existing ancestor of `dir` (including `dir` itself), or null when none
 *  exists. `git -C` treats a nonexistent directory as a plain non-zero exit, and the
 *  events file's own directory may not have been created yet at logger construction. */
function nearestExistingDir(dir: string): string | null {
  let current = dir;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** `owner/name` for the checkout containing `dir`, or null when it cannot be resolved.
 *  Never throws: every failure mode — missing directory, non-zero git exit, spawn
 *  error, timeout, unparseable remote — collapses to null. */
export function resolveRepoSlug(dir: string): string | null {
  const cached = cache.get(dir);
  if (cached !== undefined) return cached;

  let slug: string | null = null;
  try {
    const start = nearestExistingDir(dir);
    if (start !== null) {
      const r = spawnSync('git', ['-C', start, 'remote', 'get-url', 'origin'], {
        encoding: 'utf-8',
        timeout: ORIGIN_TIMEOUT_MS,
      });
      if (r.status === 0 && typeof r.stdout === 'string') {
        slug = parseRemoteSlug(r.stdout.trim());
      }
    }
  } catch {
    slug = null;
  }

  cache.set(dir, slug);
  return slug;
}
