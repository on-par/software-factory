// packages/core/src/utils/open-factory-drafts.ts — Count open factory draft PRs for status and kpis (#3553).

import type { Octokit } from '@octokit/rest';

import { resolveBranchPrefix } from '../config/index.js';

/** Open draft PRs on factory branches. `oldestHours` is null only when `count` is 0. */
export interface OpenFactoryDrafts {
  count: number;
  oldestHours: number | null;
}

/** The pulls.list fields the count reads. */
export interface OpenPrDraftSummary {
  branch: string;
  draft: boolean;
  createdAt: string;
}

const PAGE_SIZE = 100;
/** Hard stop so a misbehaving API cannot hang `factory status`; hitting it means unreadable. */
const MAX_PAGES = 50;
const HOUR_MS = 3_600_000;

/** Counts draft PRs whose head branch starts with `<prefix>/` and reports the oldest age in whole hours.
 *  An unparsable `createdAt` counts with age 0 (same rule as `findUnmergedGreenPrs`). */
export function summarizeOpenFactoryDrafts(
  prs: ReadonlyArray<OpenPrDraftSummary>,
  opts: { prefix: string; now: number },
): OpenFactoryDrafts {
  const ages = prs
    .filter((pr) => pr.draft && pr.branch.startsWith(`${opts.prefix}/`))
    .map((pr) => {
      const hours = Math.floor((opts.now - Date.parse(pr.createdAt)) / HOUR_MS);
      return Number.isFinite(hours) ? Math.max(0, hours) : 0;
    });
  return { count: ages.length, oldestHours: ages.length === 0 ? null : Math.max(...ages) };
}

/** Reads every open PR page and summarizes the factory drafts; null when the listing cannot be read. */
export async function readOpenFactoryDrafts(opts: {
  octokit: Pick<Octokit, 'rest'>;
  owner: string;
  repo: string;
  prefix?: string;
  now?: () => number;
}): Promise<OpenFactoryDrafts | null> {
  const { octokit, owner, repo, prefix = resolveBranchPrefix(), now = () => Date.now() } = opts;
  try {
    const all: OpenPrDraftSummary[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data } = await octokit.rest.pulls.list({ owner, repo, state: 'open', per_page: PAGE_SIZE, page });
      if (!Array.isArray(data)) return null;
      for (const pr of data) {
        all.push({ branch: pr.head?.ref ?? '', draft: Boolean(pr.draft), createdAt: pr.created_at ?? '' });
      }
      if (data.length < PAGE_SIZE) return summarizeOpenFactoryDrafts(all, { prefix, now: now() });
    }
    return null;
  } catch {
    return null;
  }
}

/** The `== Health ==` band line for the open factory draft count. */
export function formatOpenFactoryDraftsLine(drafts: OpenFactoryDrafts | null): string {
  if (drafts === null) return 'Open factory drafts: unavailable';
  if (drafts.count === 0) return 'Open factory drafts: 0';
  return `Open factory drafts: ${drafts.count} (oldest ${drafts.oldestHours}h)`;
}
