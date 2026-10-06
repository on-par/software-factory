// src/garden/dedup.test.ts — Read-only dedup of garden clusters (#2102)

import { describe, expect, it, vi } from 'vitest';

import type { CandidateIssue } from '../filing/index.js';
import { upstreamReportMarker } from '../filing/upstream.js';
import {
  dedupGardenClusters,
  findGardenTrackingIssue,
  gardenClusterFingerprint,
  filterGardenOnlyNew,
  gardenKeyMarker,
  markGardenTrackingUnknown,
} from './dedup.js';
import type { GardenCluster } from './harvest.js';

const cluster = (key: string, dimension: GardenCluster['dimension'] = 'signature'): GardenCluster => ({
  dimension,
  key,
  count: 2,
  issues: ['1'],
  firstSeen: 'a',
  lastSeen: 'b',
  samples: ['p:1'],
  failingChecks: ['tests'],
});

const issue = (number: number, body: string, state: 'open' | 'closed' = 'open'): CandidateIssue => ({
  number,
  body,
  state,
});

function fakeClient(byText: Record<string, CandidateIssue[]> = {}) {
  return {
    searchIssues: vi.fn(async ({ text }: { text: string }) => byText[text] ?? []),
    createIssue: vi.fn(),
    updateIssue: vi.fn(),
    commentIssue: vi.fn(),
    listCandidateIssues: vi.fn(),
  };
}

const target = { owner: 'o', repo: 'r' };

describe('gardenClusterFingerprint', () => {
  it('is deterministic, marker-safe and dimension-scoped', () => {
    const a = cluster('tests|boom');
    const fp = gardenClusterFingerprint(a);
    expect(fp).toMatch(/^garden-[0-9a-f]{16}$/);
    expect(gardenClusterFingerprint(cluster('tests|boom'))).toBe(fp);
    expect(gardenClusterFingerprint(cluster('tests|boom', 'checker'))).not.toBe(fp);
    expect(upstreamReportMarker(fp)).not.toContain('invalid');
  });
});

describe('findGardenTrackingIssue', () => {
  const c = cluster('tests|boom');
  const fpMarker = upstreamReportMarker(gardenClusterFingerprint(c));

  it('matches by fingerprint marker', () => {
    expect(findGardenTrackingIssue(c, [issue(42, `x ${fpMarker}`)])).toBe(42);
  });

  it('matches by garden key marker', () => {
    expect(findGardenTrackingIssue(c, [issue(7, gardenKeyMarker('tests|boom'))])).toBe(7);
  });

  it('ignores near misses, closed and stateless issues', () => {
    expect(
      findGardenTrackingIssue(c, [
        issue(1, `fp ${gardenClusterFingerprint(c)} in plain text`),
        issue(2, '<!-- garden:tests|boomx -->'),
        issue(3, fpMarker, 'closed'),
        { number: 4, body: fpMarker },
        { number: 5, body: '' },
      ]),
    ).toBeUndefined();
  });

  it('picks the lowest matching number', () => {
    expect(findGardenTrackingIssue(c, [issue(9, fpMarker), issue(3, fpMarker)])).toBe(3);
  });
});

describe('dedupGardenClusters', () => {
  const c = cluster('tests|boom');
  const fp = gardenClusterFingerprint(c);

  it('marks a cluster tracked via the fingerprint search', async () => {
    const client = fakeClient({ [fp]: [issue(42, upstreamReportMarker(fp))] });
    const [out] = await dedupGardenClusters([c], { client, ...target });
    expect(out?.tracking).toEqual({ status: 'tracked', issue: 42 });
  });

  it('marks a cluster tracked via the garden key search', async () => {
    const client = fakeClient({ 'garden:tests|boom': [issue(7, '<!-- garden:tests|boom -->')] });
    const [out] = await dedupGardenClusters([c], { client, ...target });
    expect(out?.tracking).toEqual({ status: 'tracked', issue: 7 });
  });

  it('marks a cluster new without results, or with only a closed match', async () => {
    const [a] = await dedupGardenClusters([c], { client: fakeClient(), ...target });
    expect(a?.tracking).toEqual({ status: 'new' });
    const client = fakeClient({ [fp]: [issue(5, upstreamReportMarker(fp), 'closed')] });
    const [b] = await dedupGardenClusters([c], { client, ...target });
    expect(b?.tracking).toEqual({ status: 'new' });
  });

  it('takes the lowest number across both searches', async () => {
    const client = fakeClient({
      [fp]: [issue(9, upstreamReportMarker(fp))],
      'garden:tests|boom': [issue(3, '<!-- garden:tests|boom -->')],
    });
    const [out] = await dedupGardenClusters([c], { client, ...target });
    expect(out?.tracking).toEqual({ status: 'tracked', issue: 3 });
  });

  it('searches only by fingerprint when the key is longer than 200 chars', async () => {
    const long = cluster('x'.repeat(201));
    const client = fakeClient();
    await dedupGardenClusters([long], { client, ...target });
    expect(client.searchIssues).toHaveBeenCalledTimes(1);
    expect(client.searchIssues).toHaveBeenCalledWith({ ...target, text: gardenClusterFingerprint(long) });
  });

  it('searches identical text once', async () => {
    const client = fakeClient();
    await dedupGardenClusters([c, { ...c }], { client, ...target });
    expect(client.searchIssues).toHaveBeenCalledTimes(2);
  });

  it('is read-only, preserves order and fields, and does not mutate input', async () => {
    const input = [cluster('a'), cluster('b', 'checker'), cluster('c', 'human')];
    const snapshot = structuredClone(input);
    const client = fakeClient();
    const out = await dedupGardenClusters(input, { client, ...target });
    expect(input).toEqual(snapshot);
    expect(out.map((x) => x.key)).toEqual(['a', 'b', 'c']);
    expect(out.map(({ tracking: _t, ...rest }) => rest)).toEqual(snapshot);
    for (const call of client.searchIssues.mock.calls)
      expect(Object.keys(call[0]).sort()).toEqual(['owner', 'repo', 'text']);
    expect(client.createIssue).not.toHaveBeenCalled();
    expect(client.updateIssue).not.toHaveBeenCalled();
    expect(client.commentIssue).not.toHaveBeenCalled();
    expect(client.listCandidateIssues).not.toHaveBeenCalled();
  });

  it('marks every cluster tracked: unknown when the search rejects', async () => {
    const input = [cluster('a'), cluster('b', 'checker'), cluster('c', 'human')];
    const snapshot = structuredClone(input);
    const client = fakeClient();
    const err = new Error('boom');
    client.searchIssues.mockRejectedValue(err);
    const onSearchError = vi.fn();
    const out = await dedupGardenClusters(input, { client, ...target, onSearchError });
    expect(out.map((x) => x.tracking)).toEqual(Array(3).fill({ status: 'unknown' }));
    expect(out.map(({ tracking: _t, ...rest }) => rest)).toEqual(snapshot);
    expect(input).toEqual(snapshot);
    expect(onSearchError).toHaveBeenCalledTimes(1);
    expect(onSearchError).toHaveBeenCalledWith(err);
  });

  it('a network failure on a later search still marks every cluster unknown', async () => {
    const first = cluster('a');
    const client = fakeClient();
    client.searchIssues
      .mockResolvedValueOnce([issue(5, gardenKeyMarker('a'))])
      .mockResolvedValueOnce([issue(5, gardenKeyMarker('a'))])
      .mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
    const out = await dedupGardenClusters([first, cluster('b')], { client, ...target });
    expect(out.map((x) => x.tracking)).toEqual([{ status: 'unknown' }, { status: 'unknown' }]);
  });

  it('works without onSearchError', async () => {
    const client = fakeClient();
    client.searchIssues.mockRejectedValue(new Error('boom'));
    const out = await dedupGardenClusters([c], { client, ...target });
    expect(out[0]?.tracking).toEqual({ status: 'unknown' });
  });
});

describe('markGardenTrackingUnknown', () => {
  it('sets unknown without mutating the input', () => {
    const input = [cluster('a')];
    const snapshot = structuredClone(input);
    expect(markGardenTrackingUnknown(input)[0]?.tracking).toEqual({ status: 'unknown' });
    expect(input).toEqual(snapshot);
  });

  it('returns an empty list for empty input', () => {
    expect(markGardenTrackingUnknown([])).toEqual([]);
  });
});

describe('filterGardenOnlyNew (#2104)', () => {
  const withTracking = (key: string, tracking?: GardenCluster['tracking']): GardenCluster => ({
    ...cluster(key),
    ...(tracking ? { tracking } : {}),
  });

  it('omits tracked clusters', () => {
    expect(filterGardenOnlyNew([withTracking('a', { status: 'tracked', issue: 7 })])).toEqual([]);
  });

  it('keeps new, unknown and unannotated clusters', () => {
    const list = [withTracking('a', { status: 'new' }), withTracking('b', { status: 'unknown' }), withTracking('c')];
    expect(filterGardenOnlyNew(list)).toEqual(list);
  });

  it('keeps survivor order and does not mutate the input', () => {
    const list = [
      withTracking('a', { status: 'new' }),
      withTracking('b', { status: 'tracked', issue: 7 }),
      withTracking('c', { status: 'unknown' }),
    ];
    const snapshot = [...list];
    expect(filterGardenOnlyNew(list).map((c) => c.key)).toEqual(['a', 'c']);
    expect(list).toEqual(snapshot);
  });

  it('returns [] for an empty list', () => {
    expect(filterGardenOnlyNew([])).toEqual([]);
  });
});
