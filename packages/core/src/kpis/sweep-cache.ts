// src/kpis/sweep-cache.ts — On-disk cursor + per-PR cache for the incremental KPI sweep

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ensureDir } from '../utils/index.js';
import type { PrDetails } from './human.js';

export const KPI_SWEEP_CACHE_VERSION = 1;

/** Cap on cached PRs, newest `updatedAt` kept, so the file cannot grow without bound. */
export const KPI_SWEEP_MAX_CACHED_PRS = 500;

export interface CachedPrDetails extends PrDetails {
  /** The PR's `updated_at` when these details were fetched. */
  updatedAt: string;
  /** Fetched after the PR merged: commits, approvals and mergedBy can no longer change, so never re-fetch. */
  final: boolean;
}

/** One factory PR as last seen in the PR list, plus its details once fetched. */
export interface CachedPr {
  number: number;
  issue: string;
  updatedAt: string;
  mergedAt: string | null;
  /** closed_at when closed WITHOUT merge, else null. */
  closedAt: string | null;
  mergeCommitSha: string | null;
  details?: CachedPrDetails;
}

export interface KpiSweepCache {
  version: typeof KPI_SWEEP_CACHE_VERSION;
  /** `owner/repo` the cache was built for; a mismatch discards it. */
  repo: string;
  /** Branch prefixes the cache was built for; a mismatch discards it. */
  prefixes: string[];
  lastSweepAt: string | null;
  /** Newest PR `updated_at` seen in the list; paging stops at PRs older than this. */
  cursor: string | null;
  /** ETag of PR-list page 1, sent back as If-None-Match (a 304 costs no rate limit). */
  listEtag: string | null;
  /** Keyed by PR number. */
  prs: Record<string, CachedPr>;
}

export function emptyKpiSweepCache(repo: string, prefixes: readonly string[]): KpiSweepCache {
  return {
    version: KPI_SWEEP_CACHE_VERSION,
    repo,
    prefixes: [...prefixes],
    lastSweepAt: null,
    cursor: null,
    listEtag: null,
    prs: {},
  };
}

/** The cache in `text` when it is valid and built for this repo and these prefixes, else an empty one. */
export function parseKpiSweepCache(text: string, repo: string, prefixes: readonly string[]): KpiSweepCache {
  const empty = emptyKpiSweepCache(repo, prefixes);
  let parsed: Partial<KpiSweepCache>;
  try {
    parsed = JSON.parse(text) as Partial<KpiSweepCache>;
  } catch {
    return empty;
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    parsed.version !== KPI_SWEEP_CACHE_VERSION ||
    parsed.repo !== repo ||
    !Array.isArray(parsed.prefixes) ||
    parsed.prefixes.join('\n') !== prefixes.join('\n') ||
    parsed.prs === null ||
    typeof parsed.prs !== 'object'
  ) {
    return empty;
  }
  return {
    ...empty,
    lastSweepAt: typeof parsed.lastSweepAt === 'string' ? parsed.lastSweepAt : null,
    cursor: typeof parsed.cursor === 'string' ? parsed.cursor : null,
    listEtag: typeof parsed.listEtag === 'string' ? parsed.listEtag : null,
    prs: parsed.prs,
  };
}

export function readKpiSweepCache(path: string, repo: string, prefixes: readonly string[]): KpiSweepCache {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return emptyKpiSweepCache(repo, prefixes);
  }
  return parseKpiSweepCache(text, repo, prefixes);
}

/** Drops the oldest-updated PRs beyond `max`. */
export function pruneKpiSweepCache(cache: KpiSweepCache, max = KPI_SWEEP_MAX_CACHED_PRS): KpiSweepCache {
  const entries = Object.entries(cache.prs);
  if (entries.length <= max) return cache;
  entries.sort(([, a], [, b]) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { ...cache, prs: Object.fromEntries(entries.slice(0, max)) };
}

/** Writes via a temp file + rename so a crash mid-write never leaves a torn cache. */
export function writeKpiSweepCache(path: string, cache: KpiSweepCache): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cache)}\n`);
  renameSync(tmp, path);
}
