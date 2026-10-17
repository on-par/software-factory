// src/kpis/sweep.ts — Rate-limit-aware, incremental fetch of KPI human-event sources
//
// The uncached `fetchHumanEventSources` costs ~3 + 2N + M REST calls per sweep (N matched PRs,
// M merged), which let a looping lane exhaust the 5000/hr core budget. This path:
//   - reads GET /rate_limit (free) first and skips when core remaining < 20% of the limit;
//   - sends If-None-Match with the stored ETag on PR-list page 1 (a 304 costs nothing);
//   - stops paging at PRs older than the stored cursor (the list is sorted by updated desc);
//   - fetches details only for PRs whose `updated_at` moved, never for PRs already cached as merged;
//   - batches those details into GraphQL queries (separate budget), REST when no `graphql` is offered.

import type { FactoryEvent } from '../types/index.js';
import {
  factoryPrIssue,
  fetchPrDetailsRest,
  resolveKpiBranchPrefixes,
  type HumanSourceClient,
  type PrDetails,
  type PrSource,
} from './human.js';
import {
  pruneKpiSweepCache,
  readKpiSweepCache,
  writeKpiSweepCache,
  type CachedPr,
  type KpiSweepCache,
} from './sweep-cache.js';

/** Skip the sweep when the REST core bucket has less than this share of its limit left. */
export const KPI_SWEEP_MIN_CORE_REMAINING_RATIO = 0.2;

/** PR-list pages read at most per sweep (100 PRs each), as the uncached fetch always did. */
export const KPI_SWEEP_MAX_LIST_PAGES = 3;

/** PRs per GraphQL details query. */
export const KPI_SWEEP_GRAPHQL_BATCH = 25;

/** Events a run logs when it opened, readied or merged a PR; a run with none of them is a no-op for KPIs. */
export const KPI_PRODUCTIVE_EVENT_KINDS: ReadonlySet<string> = new Set(['pr_opened', 'ready', 'merged', 'landed']);

export interface KpiSweepClient extends HumanSourceClient {
  rest: {
    pulls: Omit<HumanSourceClient['rest']['pulls'], 'list'> & {
      list(params: {
        owner: string;
        repo: string;
        state: 'all';
        per_page: number;
        page: number;
        sort: 'updated';
        direction: 'desc';
        headers?: Record<string, string>;
      }): Promise<{ data: any[]; headers?: Record<string, unknown> }>;
    };
    rateLimit: { get(): Promise<{ data: any }> };
  };
  graphql?: (query: string, variables: Record<string, unknown>) => Promise<any>;
}

export type KpiSweepBudget =
  { ok: true; remaining: number; limit: number } | { ok: false; reason: string; remaining?: number; limit?: number };

/** Thrown instead of sweeping when the budget guard trips; reconstructKpiEvents turns it into a partial snapshot. */
export class KpiSweepSkippedError extends Error {
  override name = 'KpiSweepSkippedError';
}

/** True when `events` logged at or after `sinceIso` include a PR opened, readied or merged. */
export function runProducedPrOrMerge(events: readonly FactoryEvent[], sinceIso: string): boolean {
  const since = Date.parse(sinceIso);
  return events.some((e) => KPI_PRODUCTIVE_EVENT_KINDS.has(e.type) && !(Date.parse(e.ts) < since));
}

/** Reads GET /rate_limit (not counted against the budget). Any failure means "do not sweep". */
export async function checkKpiSweepBudget(
  client: Pick<KpiSweepClient, 'rest'>,
  minRatio = KPI_SWEEP_MIN_CORE_REMAINING_RATIO,
): Promise<KpiSweepBudget> {
  let core: { limit?: unknown; remaining?: unknown } | undefined;
  try {
    const { data } = await client.rest.rateLimit.get();
    core = data?.resources?.core ?? data?.rate;
  } catch (err: any) {
    return { ok: false, reason: `GitHub rate_limit check failed (${err?.message ?? String(err)})` };
  }
  const { limit, remaining } = core ?? {};
  if (typeof limit !== 'number' || typeof remaining !== 'number' || limit <= 0) {
    return { ok: false, reason: 'GitHub rate_limit response has no core bucket' };
  }
  if (remaining < limit * minRatio) {
    return {
      ok: false,
      remaining,
      limit,
      reason: `GitHub REST core budget low: ${remaining}/${limit} remaining (< ${Math.round(minRatio * 100)}%)`,
    };
  }
  return { ok: true, remaining, limit };
}

function isNotModified(err: unknown): boolean {
  return (err as { status?: unknown } | null)?.status === 304;
}

function isOlder(a: string, b: string): boolean {
  return Date.parse(a) < Date.parse(b);
}

/** Merges PR-list changes since the cursor into a copy of `cache`. A 304 on page 1 means nothing changed. */
async function refreshPrList(
  client: KpiSweepClient,
  owner: string,
  repo: string,
  prefixes: readonly string[],
  cache: KpiSweepCache,
): Promise<KpiSweepCache> {
  const next: KpiSweepCache = { ...cache, prs: { ...cache.prs } };
  let newest = cache.cursor;
  for (let page = 1; page <= KPI_SWEEP_MAX_LIST_PAGES; page++) {
    const conditional = page === 1 && cache.listEtag !== null && cache.cursor !== null;
    let res: Awaited<ReturnType<KpiSweepClient['rest']['pulls']['list']>>;
    try {
      res = await client.rest.pulls.list({
        owner,
        repo,
        state: 'all',
        per_page: 100,
        page,
        sort: 'updated',
        direction: 'desc',
        ...(conditional ? { headers: { 'if-none-match': cache.listEtag! } } : {}),
      });
    } catch (err) {
      if (conditional && isNotModified(err)) return cache;
      throw err;
    }
    if (page === 1) {
      const etag = res.headers?.etag;
      next.listEtag = typeof etag === 'string' ? etag : null;
    }
    let reachedCursor = false;
    for (const pr of res.data) {
      const updatedAt: string = pr.updated_at ?? '';
      if (cache.cursor !== null && updatedAt && isOlder(updatedAt, cache.cursor)) {
        reachedCursor = true;
        break;
      }
      if (updatedAt && (newest === null || isOlder(newest, updatedAt))) newest = updatedAt;
      const issue = factoryPrIssue(pr, prefixes);
      if (issue === null) continue;
      const mergedAt: string | null = pr.merged_at ?? null;
      const prior = cache.prs[String(pr.number)]?.details;
      next.prs[String(pr.number)] = {
        number: pr.number,
        issue: String(issue),
        updatedAt,
        mergedAt,
        closedAt: pr.state === 'closed' && mergedAt === null ? (pr.closed_at ?? null) : null,
        mergeCommitSha: pr.merge_commit_sha ?? null,
        ...(prior ? { details: prior } : {}),
      };
    }
    if (reachedCursor || res.data.length < 100) break;
  }
  next.cursor = newest;
  return next;
}

/** Details missing, or fetched before a later update — unless fetched after merge (final). */
export function needsDetails(pr: CachedPr): boolean {
  if (!pr.details) return true;
  if (pr.details.final) return false;
  return pr.details.updatedAt !== pr.updatedAt;
}

const GRAPHQL_PR_FIELDS =
  'mergedBy { login } ' +
  'commits(first: 100) { nodes { commit { oid authoredDate author { name user { login } } } } } ' +
  'reviews(first: 100, states: APPROVED) { nodes { author { login } submittedAt } }';

/** One aliased query fetching commits, approvals and mergedBy for every PR in `numbers`. */
export function buildPrDetailsQuery(numbers: readonly number[]): string {
  const fields = numbers.map((n) => {
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`invalid PR number ${n}`);
    return `pr${n}: pullRequest(number: ${n}) { ${GRAPHQL_PR_FIELDS} }`;
  });
  return `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${fields.join(' ')} } }`;
}

function detailsFromGraphql(node: any, merged: boolean): PrDetails {
  const commits = (node?.commits?.nodes ?? []).map((n: any) => ({
    sha: n.commit.oid,
    author: n.commit.author?.user?.login ?? n.commit.author?.name ?? 'unknown',
    ts: n.commit.authoredDate,
  }));
  const approvals = (node?.reviews?.nodes ?? []).map((r: any) => ({
    actor: r.author?.login ?? 'unknown',
    ts: r.submittedAt,
  }));
  return { commits, approvals, mergedBy: merged ? node?.mergedBy?.login : undefined };
}

async function fetchDetails(
  client: KpiSweepClient,
  owner: string,
  repo: string,
  prs: readonly CachedPr[],
): Promise<Map<number, PrDetails>> {
  const out = new Map<number, PrDetails>();
  let viaRest = prs;
  if (typeof client.graphql === 'function') {
    for (let i = 0; i < prs.length; i += KPI_SWEEP_GRAPHQL_BATCH) {
      const batch = prs.slice(i, i + KPI_SWEEP_GRAPHQL_BATCH);
      const data = await client.graphql(buildPrDetailsQuery(batch.map((pr) => pr.number)), { owner, repo });
      for (const pr of batch) {
        const node = data?.repository?.[`pr${pr.number}`];
        if (node) out.set(pr.number, detailsFromGraphql(node, pr.mergedAt !== null));
      }
    }
    // A PR missing from the GraphQL response (partial error) falls back to REST.
    viaRest = prs.filter((pr) => !out.has(pr.number));
  }
  await Promise.all(
    viaRest.map(async (pr) => {
      out.set(pr.number, await fetchPrDetailsRest(client, owner, repo, pr.number, pr.mergedAt !== null));
    }),
  );
  return out;
}

function toPrSource(pr: CachedPr): PrSource {
  const { commits = [], approvals = [], mergedBy } = pr.details ?? {};
  return {
    issue: pr.issue,
    prNumber: pr.number,
    commits,
    approvals,
    mergedAt: pr.mergedAt,
    mergedBy,
    closedAt: pr.closedAt,
    mergeCommitSha: pr.mergeCommitSha,
  };
}

export interface KpiSweepOptions {
  /** Cache file, e.g. `getFactoryPaths(root).kpiSweepCache`. */
  cachePath: string;
  now?: () => Date;
  minCoreRemainingRatio?: number;
}

/** Same result shape as `fetchHumanEventSources`, at O(changed PRs) cost. Throws KpiSweepSkippedError when the budget guard trips. */
export async function fetchHumanEventSourcesCached(
  client: KpiSweepClient,
  owner: string,
  repo: string,
  issues: ReadonlySet<string> | null,
  branchPrefixes: string | readonly string[] | undefined,
  opts: KpiSweepOptions,
): Promise<PrSource[]> {
  const budget = await checkKpiSweepBudget(client, opts.minCoreRemainingRatio);
  if (!budget.ok) throw new KpiSweepSkippedError(`KPI sweep skipped: ${budget.reason}`);

  const prefixes = resolveKpiBranchPrefixes(branchPrefixes);
  const cached = readKpiSweepCache(opts.cachePath, `${owner}/${repo}`, prefixes);
  const cache = await refreshPrList(client, owner, repo, prefixes, cached);

  const wanted = Object.values(cache.prs)
    .filter((pr) => issues === null || issues.has(pr.issue))
    .sort((a, b) => a.number - b.number);
  const stale = wanted.filter(needsDetails);
  const fetched = await fetchDetails(client, owner, repo, stale);
  for (const pr of stale) {
    const details = fetched.get(pr.number);
    if (!details) continue;
    pr.details = { ...details, updatedAt: pr.updatedAt, final: pr.mergedAt !== null };
  }

  cache.lastSweepAt = (opts.now?.() ?? new Date()).toISOString();
  writeKpiSweepCache(opts.cachePath, pruneKpiSweepCache(cache));
  return wanted.map(toPrSource);
}
