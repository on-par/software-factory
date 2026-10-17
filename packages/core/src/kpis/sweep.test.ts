import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FactoryEvent } from '../types/index.js';
import { fetchHumanEventSources } from './human.js';
import {
  buildPrDetailsQuery,
  checkKpiSweepBudget,
  fetchHumanEventSourcesCached,
  KPI_SWEEP_GRAPHQL_BATCH,
  KpiSweepSkippedError,
  needsDetails,
  runProducedPrOrMerge,
} from './sweep.js';

interface FakePr {
  number: number;
  head: { ref: string };
  state: 'open' | 'closed';
  merged_at: string | null;
  closed_at: string | null;
  merge_commit_sha: string | null;
  updated_at: string;
}

const T0 = Date.parse('2026-10-01T00:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

/** `n` factory PRs, the first `merged` of them merged; PR i was last updated at minute i. */
function makePrs(n: number, merged: number): FakePr[] {
  return Array.from({ length: n }, (_, i) => {
    const number = i + 1;
    const isMerged = number <= merged;
    return {
      number,
      head: { ref: `factory/${number}-work` },
      state: isMerged ? 'closed' : 'open',
      merged_at: isMerged ? at(number) : null,
      closed_at: isMerged ? at(number) : null,
      merge_commit_sha: isMerged ? `sha${number}` : null,
      updated_at: at(number),
    };
  });
}

/** A GitHub double that counts every call, honours If-None-Match on PR-list page 1, and serves GraphQL when asked. */
function fakeGitHub(prs: FakePr[], opts: { graphql?: boolean; remaining?: number; limit?: number } = {}) {
  const calls = { rateLimit: 0, list: 0, listCommits: 0, listReviews: 0, get: 0, graphql: 0 };
  const sorted = () => [...prs].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  const commit = (n: number) => ({
    sha: `c${n}abcdef`,
    author: { login: 'factory-bot' },
    commit: { author: { name: 'Factory', date: at(n) } },
  });
  const client: any = {
    rest: {
      rateLimit: {
        get: async () => {
          calls.rateLimit++;
          return { data: { resources: { core: { limit: opts.limit ?? 5000, remaining: opts.remaining ?? 5000 } } } };
        },
      },
      pulls: {
        list: async ({ page, per_page, headers }: any) => {
          calls.list++;
          const data = sorted().slice((page - 1) * per_page, page * per_page);
          const etag = `"${data.map((p) => `${p.number}@${p.updated_at}`).join(',')}"`;
          if (headers?.['if-none-match'] === etag) throw Object.assign(new Error('Not modified'), { status: 304 });
          return { data, headers: { etag } };
        },
        listCommits: async ({ pull_number }: any) => {
          calls.listCommits++;
          return { data: [commit(pull_number)] };
        },
        listReviews: async ({ pull_number }: any) => {
          calls.listReviews++;
          return { data: [{ state: 'APPROVED', user: { login: 'rev' }, submitted_at: at(pull_number) }] };
        },
        get: async () => {
          calls.get++;
          return { data: { merged_by: { login: 'merger' } } };
        },
      },
    },
  };
  if (opts.graphql) {
    client.graphql = async (query: string) => {
      calls.graphql++;
      const repository: Record<string, unknown> = {};
      for (const [, n] of query.matchAll(/pr(\d+): pullRequest/g)) {
        const num = Number(n);
        repository[`pr${num}`] = {
          mergedBy: { login: 'merger' },
          commits: {
            nodes: [
              {
                commit: {
                  oid: `c${num}abcdef`,
                  authoredDate: at(num),
                  author: { name: 'Factory', user: { login: 'factory-bot' } },
                },
              },
            ],
          },
          reviews: { nodes: [{ author: { login: 'rev' }, submittedAt: at(num) }] },
        };
      }
      return { repository };
    };
  }
  const restCalls = () => calls.list + calls.listCommits + calls.listReviews + calls.get;
  const reset = () => {
    for (const key of Object.keys(calls) as Array<keyof typeof calls>) calls[key] = 0;
  };
  return { client, calls, restCalls, reset };
}

let dir: string;
let cachePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kpi-sweep-'));
  cachePath = join(dir, 'state', 'kpi-sweep-cache.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sweep = (client: any, issues: ReadonlySet<string> | null = null) =>
  fetchHumanEventSourcesCached(client, 'o', 'r', issues, 'factory', { cachePath });

/** Moves PR `number` to the top of the updated-desc list, as a push or review would. */
function touch(prs: FakePr[], number: number, minutes = 100_000): void {
  prs[number - 1].updated_at = at(minutes + number);
}

describe('fetchHumanEventSourcesCached call budget', () => {
  it('documents the old vs new cost for 300 matched PRs, 200 merged', async () => {
    const prs = makePrs(300, 200);
    const old = fakeGitHub(prs);
    await fetchHumanEventSources(old.client, 'o', 'r', null, 'factory');
    const before = old.restCalls();

    const rest = fakeGitHub(prs);
    await sweep(rest.client);
    const coldRest = rest.restCalls();
    rest.reset();
    await sweep(rest.client);
    const warmRest = rest.restCalls();

    rmSync(cachePath);
    const gql = fakeGitHub(prs, { graphql: true });
    await sweep(gql.client);
    const cold = { rest: gql.restCalls(), graphql: gql.calls.graphql };
    gql.reset();
    for (const n of [201, 202, 203, 204, 205]) touch(prs, n);
    await sweep(gql.client);
    const fiveChanged = { rest: gql.restCalls(), graphql: gql.calls.graphql };

    console.info(
      `KPI sweep cost, 300 matched PRs / 200 merged: old=${before} REST per run; ` +
        `new REST-only cold=${coldRest} warm=${warmRest}; ` +
        `new GraphQL cold=${cold.rest} REST + ${cold.graphql} GraphQL; 5 changed=${fiveChanged.rest} REST + ${fiveChanged.graphql} GraphQL`,
    );
    expect(before).toBe(3 + 2 * 300 + 200); // 803, every run
    expect(coldRest).toBe(before); // one-time fill without GraphQL
    expect(warmRest).toBe(1); // one conditional list request answered 304
    expect(cold).toEqual({ rest: 3, graphql: Math.ceil(300 / KPI_SWEEP_GRAPHQL_BATCH) });
    expect(fiveChanged).toEqual({ rest: 1, graphql: 1 });
  });

  it('a normal run with K changed PRs out of N costs O(K) REST calls, not O(N)', async () => {
    const prs = makePrs(300, 200);
    const gh = fakeGitHub(prs);
    await sweep(gh.client);
    gh.reset();
    const K = 7;
    for (let n = 250; n < 250 + K; n++) touch(prs, n);
    await sweep(gh.client);
    expect(gh.restCalls()).toBeLessThanOrEqual(2 + 2 * K);
    expect(gh.calls.listCommits).toBe(K);
    expect(gh.calls.listReviews).toBe(K);
  });

  it('a second run with no changes makes only the conditional list request (304)', async () => {
    const gh = fakeGitHub(makePrs(50, 20), { graphql: true });
    await sweep(gh.client);
    gh.reset();
    const sources = await sweep(gh.client);
    expect(gh.calls).toMatchObject({ list: 1, listCommits: 0, listReviews: 0, get: 0, graphql: 0 });
    expect(sources).toHaveLength(50);
  });

  it('stops paging at the cursor when the server sends no ETag', async () => {
    const prs = makePrs(250, 0);
    const gh = fakeGitHub(prs);
    const list = gh.client.rest.pulls.list;
    gh.client.rest.pulls.list = async (params: any) => ({ data: (await list(params)).data });
    await sweep(gh.client);
    gh.reset();
    touch(prs, 3);
    await sweep(gh.client);
    expect(gh.calls).toMatchObject({ list: 1, listCommits: 1, listReviews: 1 });
  });

  it('never re-fetches a merged PR, even when its updated_at moves', async () => {
    const prs = makePrs(30, 30);
    const gh = fakeGitHub(prs);
    await sweep(gh.client);
    gh.reset();
    for (let n = 1; n <= 30; n++) touch(prs, n);
    await sweep(gh.client);
    await sweep(gh.client);
    expect(gh.calls).toMatchObject({ listCommits: 0, listReviews: 0, get: 0 });
  });

  it('re-fetches an open PR once when it merges, then never again', async () => {
    const prs = makePrs(5, 0);
    const gh = fakeGitHub(prs);
    await sweep(gh.client);
    gh.reset();
    Object.assign(prs[2], { state: 'closed', merged_at: at(500), closed_at: at(500), merge_commit_sha: 'm3' });
    touch(prs, 3);
    const [, , third] = await sweep(gh.client);
    expect(gh.calls).toMatchObject({ listCommits: 1, listReviews: 1, get: 1 });
    expect(third).toMatchObject({ prNumber: 3, mergedAt: at(500), mergedBy: 'merger', mergeCommitSha: 'm3' });
    gh.reset();
    touch(prs, 3, 200_000);
    await sweep(gh.client);
    expect(gh.calls).toMatchObject({ listCommits: 0, listReviews: 0, get: 0 });
  });

  it('caches a closed-unmerged PR until its updated_at changes', async () => {
    const prs = makePrs(3, 0);
    Object.assign(prs[0], { state: 'closed', closed_at: at(1) });
    const gh = fakeGitHub(prs);
    const [first] = await sweep(gh.client);
    expect(first.closedAt).toBe(at(1));
    gh.reset();
    await sweep(gh.client);
    expect(gh.calls.listCommits).toBe(0);
    Object.assign(prs[0], { state: 'open', closed_at: null });
    touch(prs, 1);
    const [reopened] = await sweep(gh.client);
    expect(gh.calls.listCommits).toBe(1);
    expect(reopened.closedAt).toBeNull();
  });

  it('fetches details only for wanted issues, and later for issues that join the set', async () => {
    const gh = fakeGitHub(makePrs(10, 0));
    const sources = await sweep(gh.client, new Set(['2', '4']));
    expect(sources.map((s) => s.issue)).toEqual(['2', '4']);
    expect(gh.calls.listCommits).toBe(2);
    gh.reset();
    await sweep(gh.client, new Set(['2', '4', '6']));
    expect(gh.calls.listCommits).toBe(1);
  });
});

describe('fetchHumanEventSourcesCached results', () => {
  it('returns the same sources as the uncached REST fetch, via REST and via GraphQL', async () => {
    const prs = makePrs(12, 5);
    Object.assign(prs[7], { state: 'closed', closed_at: at(8) });
    const byNumber = (a: { prNumber: number }, b: { prNumber: number }) => a.prNumber - b.prNumber;
    const expected = (await fetchHumanEventSources(fakeGitHub(prs).client, 'o', 'r', null, 'factory')).sort(byNumber);
    expect((await sweep(fakeGitHub(prs).client)).sort(byNumber)).toEqual(expected);
    rmSync(cachePath);
    expect((await sweep(fakeGitHub(prs, { graphql: true }).client)).sort(byNumber)).toEqual(expected);
  });

  it('falls back to REST for a PR the GraphQL response leaves out', async () => {
    const gh = fakeGitHub(makePrs(3, 0), { graphql: true });
    gh.client.graphql = async () => {
      gh.calls.graphql++;
      return { repository: { pullRequest: { id: 'unrelated' } } };
    };
    const sources = await sweep(gh.client);
    expect(gh.calls).toMatchObject({ graphql: 1, listCommits: 3, listReviews: 3 });
    expect(sources[0].commits).toHaveLength(1);
  });

  it('ignores PRs whose branch is not a factory branch', async () => {
    const prs = makePrs(3, 0);
    prs[1].head.ref = 'feature/2-hand-made';
    const gh = fakeGitHub(prs);
    expect((await sweep(gh.client)).map((s) => s.prNumber)).toEqual([1, 3]);
  });

  it('persists the cursor, ETag and lastSweepAt to the cache file', async () => {
    const gh = fakeGitHub(makePrs(2, 0));
    await fetchHumanEventSourcesCached(gh.client, 'o', 'r', null, 'factory', {
      cachePath,
      now: () => new Date('2026-10-17T12:00:00Z'),
    });
    const cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
    expect(cache).toMatchObject({ repo: 'o/r', cursor: at(2), lastSweepAt: '2026-10-17T12:00:00.000Z' });
    expect(cache.listEtag).toContain('2@');
    expect(Object.keys(cache.prs)).toEqual(['1', '2']);
  });

  it('starts over when the cache file is corrupt', async () => {
    writeFileSync(join(dir, 'corrupt.json'), '{not json');
    const gh = fakeGitHub(makePrs(2, 0));
    const sources = await fetchHumanEventSourcesCached(gh.client, 'o', 'r', null, 'factory', {
      cachePath: join(dir, 'corrupt.json'),
    });
    expect(sources).toHaveLength(2);
  });

  it('rethrows a list failure that is not a 304', async () => {
    const gh = fakeGitHub(makePrs(2, 0));
    gh.client.rest.pulls.list = async () => {
      throw Object.assign(new Error('boom'), { status: 500 });
    };
    await expect(sweep(gh.client)).rejects.toThrow('boom');
  });
});

describe('KPI sweep budget guard', () => {
  it('skips with zero sweep calls when core remaining is under 20% of the limit', async () => {
    const gh = fakeGitHub(makePrs(300, 200), { remaining: 999, limit: 5000 });
    const err = await sweep(gh.client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KpiSweepSkippedError);
    expect((err as Error).message).toBe('KPI sweep skipped: GitHub REST core budget low: 999/5000 remaining (< 20%)');
    expect(gh.restCalls()).toBe(0);
    expect(gh.calls.graphql).toBe(0);
  });

  it('sweeps at exactly 20% remaining', async () => {
    await expect(checkKpiSweepBudget(fakeGitHub([], { remaining: 1000 }).client)).resolves.toEqual({
      ok: true,
      remaining: 1000,
      limit: 5000,
    });
  });

  it('skips safely when the rate_limit call fails or has no core bucket', async () => {
    const failing = { rest: { rateLimit: { get: async () => Promise.reject(new Error('offline')) } } } as any;
    await expect(checkKpiSweepBudget(failing)).resolves.toEqual({
      ok: false,
      reason: 'GitHub rate_limit check failed (offline)',
    });
    const empty = { rest: { rateLimit: { get: async () => ({ data: {} }) } } } as any;
    await expect(checkKpiSweepBudget(empty)).resolves.toMatchObject({ ok: false });
    const missing = { rest: {} } as any;
    await expect(checkKpiSweepBudget(missing)).resolves.toMatchObject({ ok: false });
  });

  it('accepts the legacy top-level `rate` bucket', async () => {
    const legacy = { rest: { rateLimit: { get: async () => ({ data: { rate: { limit: 60, remaining: 59 } } }) } } };
    await expect(checkKpiSweepBudget(legacy as any)).resolves.toMatchObject({ ok: true, remaining: 59 });
  });
});

describe('runProducedPrOrMerge', () => {
  const ev = (type: string, ts: string): FactoryEvent => ({ ts, type, issue: '1', msg: '' }) as FactoryEvent;
  const start = '2026-10-17T10:00:00.000Z';

  it('is false for a run that only claimed, released or paused', () => {
    const events = [ev('lane-start', start), ev('lane-paused', start), ev('parked', start), ev('run-done', start)];
    expect(runProducedPrOrMerge(events, start)).toBe(false);
  });

  it('is true when the run opened, readied or merged a PR', () => {
    for (const type of ['pr_opened', 'ready', 'merged', 'landed']) {
      expect(runProducedPrOrMerge([ev(type, '2026-10-17T10:05:00.000Z')], start)).toBe(true);
    }
  });

  it('ignores PRs opened before this run started', () => {
    expect(runProducedPrOrMerge([ev('merged', '2026-10-17T09:59:59.000Z')], start)).toBe(false);
  });
});

describe('sweep helpers', () => {
  it('needsDetails: missing → yes, final → never, else when updated_at moved', () => {
    const base = { number: 1, issue: '1', updatedAt: at(2), mergedAt: null, closedAt: null, mergeCommitSha: null };
    const details = { commits: [], approvals: [], updatedAt: at(1), final: false };
    expect(needsDetails(base)).toBe(true);
    expect(needsDetails({ ...base, details })).toBe(true);
    expect(needsDetails({ ...base, details: { ...details, updatedAt: at(2) } })).toBe(false);
    expect(needsDetails({ ...base, details: { ...details, final: true } })).toBe(false);
  });

  it('buildPrDetailsQuery aliases each PR and rejects non-integer numbers', () => {
    const query = buildPrDetailsQuery([7, 12]);
    expect(query).toContain('pr7: pullRequest(number: 7)');
    expect(query).toContain('pr12: pullRequest(number: 12)');
    expect(query).toContain('reviews(first: 100, states: APPROVED)');
    expect(() => buildPrDetailsQuery([1.5])).toThrow('invalid PR number');
  });
});
