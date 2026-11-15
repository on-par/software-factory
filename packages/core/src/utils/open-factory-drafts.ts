import type { Octokit } from '@octokit/rest';

import { resolveBranchPrefix } from '../config/index.js';

export interface OpenFactoryDrafts {
  count: number;
  oldestHours: number | null;
}

export interface OpenPrDraftSummary {
  branch: string;
  draft: boolean;
  createdAt: string;
}

const PAGE_SIZE = 100;
const MAX_PAGES_BEFORE_UNREADABLE = 50;
const HOUR_MS = 3_600_000;

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
    for (let page = 1; page <= MAX_PAGES_BEFORE_UNREADABLE; page++) {
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

export function formatOpenFactoryDraftsLine(drafts: OpenFactoryDrafts | null): string {
  if (drafts === null) return 'Open factory drafts: unavailable';
  if (drafts.count === 0) return 'Open factory drafts: 0';
  return `Open factory drafts: ${drafts.count} (oldest ${drafts.oldestHours}h)`;
}
