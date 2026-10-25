// packages/core/src/run/pr-lookup.ts — the one open-PR lookup: same-repo head guard, found/none/ambiguous/error (#3439, ADR-0035)

import type { Octokit } from '@octokit/rest';
import type { WorkKey } from '../work/work-key.js';

/** One open same-repo PR that matched a lookup. */
export interface OpenPrMatch {
  prNumber: number;
  branch: string;
  headSha: string;
}

/** ADR-0035: callers branch on every status; only `none` means "no PR exists". */
export type OpenPrLookup =
  | ({ status: 'found' } & OpenPrMatch)
  | { status: 'none' }
  | { status: 'ambiguous'; prs: OpenPrMatch[] }
  | { status: 'error'; detail: string };

/** The fields of a `pulls.list` item the lookups read. Payloads may omit any of them. */
export interface OpenPullSummary {
  number: number;
  body?: string | null;
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null } | null;
}

const PER_PAGE = 100;

/**
 * Lists open PRs (paginated up to `maxPages`) and keeps the same-repo ones that satisfy `matches`. A PR whose head
 * repo is a fork, or was deleted, is never returned. Fails closed with `error` when the list is longer than the cap.
 */
export async function lookupOpenPrs(opts: {
  octokit: Pick<Octokit, 'rest'>;
  repo: string;
  matches: (pr: OpenPullSummary) => boolean;
  head?: string;
  maxPages?: number;
}): Promise<OpenPrLookup> {
  const { octokit, repo, matches, head, maxPages = 10 } = opts;
  const [owner, name] = repo.split('/');
  const found: OpenPrMatch[] = [];
  try {
    for (let page = 1; page <= maxPages; page++) {
      const { data } = await octokit.rest.pulls.list({
        owner,
        repo: name,
        state: 'open',
        per_page: PER_PAGE,
        page,
        ...(head ? { head } : {}),
      });
      for (const pr of data as OpenPullSummary[]) {
        const ref = pr.head?.ref;
        if (!ref) continue;
        if (pr.head?.repo?.full_name?.toLowerCase() !== repo.toLowerCase()) continue;
        if (!matches(pr)) continue;
        found.push({ prNumber: pr.number, branch: ref, headSha: pr.head?.sha ?? '' });
      }
      if (data.length < PER_PAGE) break;
      if (page === maxPages) return { status: 'error', detail: `open PR list exceeds ${maxPages * PER_PAGE}` };
    }
  } catch (err) {
    return { status: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
  found.sort((a, b) => a.prNumber - b.prNumber);
  if (found.length === 0) return { status: 'none' };
  if (found.length === 1) return { status: 'found', ...found[0] };
  return { status: 'ambiguous', prs: found };
}

/** The open same-repo PR whose body says `closes #<issue>`. */
export function lookupOpenPrByIssue(opts: {
  octokit: Pick<Octokit, 'rest'>;
  repo: string;
  issue: WorkKey;
  maxPages?: number;
}): Promise<OpenPrLookup> {
  const pattern = new RegExp(`\\bcloses\\s+#${opts.issue}\\b`, 'i');
  return lookupOpenPrs({
    octokit: opts.octokit,
    repo: opts.repo,
    maxPages: opts.maxPages,
    matches: (pr) => pattern.test(pr.body ?? ''),
  });
}

/** The open same-repo PR whose head branch is exactly `branch`. */
export function lookupOpenPrByBranch(opts: {
  octokit: Pick<Octokit, 'rest'>;
  repo: string;
  branch: string;
}): Promise<OpenPrLookup> {
  const { octokit, repo, branch } = opts;
  return lookupOpenPrs({
    octokit,
    repo,
    head: `${repo.split('/')[0]}:${branch}`,
    matches: (pr) => pr.head?.ref === branch,
  });
}
