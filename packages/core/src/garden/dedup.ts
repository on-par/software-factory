// src/garden/dedup.ts — Read-only dedup of garden clusters against open issues via GitHub search (#2102)

import { createHash } from 'node:crypto';

import type { CandidateIssue, FilingGitHubClient } from '../filing/index.js';
import { upstreamReportMarker } from '../filing/upstream.js';
import type { GardenCluster } from './harvest.js';

/** GitHub search queries are capped at 256 chars; longer keys are matched by fingerprint only. */
const MAX_KEY_SEARCH_CHARS = 200;

/**
 * Stable, marker-safe fingerprint for a cluster: matches `[A-Za-z0-9_-]{1,64}` so
 * `upstreamReportMarker` never maps it to `invalid`. Dimension-scoped, because the
 * same key can appear in two dimensions.
 */
export function gardenClusterFingerprint(cluster: Pick<GardenCluster, 'dimension' | 'key'>): string {
  return `garden-${createHash('sha256').update(`${cluster.dimension}\n${cluster.key}`).digest('hex').slice(0, 16)}`;
}

export function gardenKeyMarker(key: string): string {
  return `<!-- garden:${key} -->`;
}

/** Lowest open issue number whose body carries the cluster's exact marker; closed issues never track. */
export function findGardenTrackingIssue(
  cluster: Pick<GardenCluster, 'dimension' | 'key'>,
  issues: readonly CandidateIssue[],
): number | undefined {
  const fpMarker = upstreamReportMarker(gardenClusterFingerprint(cluster));
  const keyMarker = gardenKeyMarker(cluster.key);
  const numbers = issues
    .filter((i) => i.state === 'open')
    .filter((i) => {
      const body = i.body ?? '';
      return body.includes(fpMarker) || body.includes(keyMarker);
    })
    .map((i) => i.number);
  return numbers.length === 0 ? undefined : Math.min(...numbers);
}

export async function dedupGardenClusters(
  clusters: readonly GardenCluster[],
  opts: { client: Pick<FilingGitHubClient, 'searchIssues'>; owner: string; repo: string },
): Promise<GardenCluster[]> {
  const { client, owner, repo } = opts;
  const cache = new Map<string, Promise<CandidateIssue[]>>();
  const search = (text: string): Promise<CandidateIssue[]> => {
    let hit = cache.get(text);
    if (!hit) {
      hit = client.searchIssues({ owner, repo, text });
      cache.set(text, hit);
    }
    return hit;
  };
  const out: GardenCluster[] = [];
  for (const c of clusters) {
    const texts = [gardenClusterFingerprint(c)];
    if (c.key.length <= MAX_KEY_SEARCH_CHARS) texts.push(`garden:${c.key}`);
    const found: CandidateIssue[] = [];
    for (const text of texts) found.push(...(await search(text)));
    const n = findGardenTrackingIssue(c, found);
    out.push({ ...c, tracking: n === undefined ? { status: 'new' } : { status: 'tracked', issue: n } });
  }
  return out;
}
