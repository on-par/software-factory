// src/garden/dedup.test.ts — Read-only dedup of garden clusters (#2102)

import { describe, expect, it, vi } from 'vitest';

import type { CandidateIssue } from '../filing/index.js';
import { upstreamReportMarker } from '../filing/upstream.js';
import { dedupGardenClusters, findGardenTrackingIssue, gardenClusterFingerprint, gardenKeyMarker } from './dedup.js';
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

  it('propagates a search rejection', async () => {
    const client = fakeClient();
    client.searchIssues.mockRejectedValue(new Error('boom'));
    await expect(dedupGardenClusters([c], { client, ...target })).rejects.toThrow('boom');
  });
});
