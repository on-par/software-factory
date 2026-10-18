import type { Octokit } from '@octokit/rest';
import { factoryBranchIssue } from '../utils/index.js';

export type AdoptablePrLookup =
  | { status: 'found'; prNumber: number; branch: string; headSha: string }
  | { status: 'absent' }
  | { status: 'ambiguous'; prs: Array<{ prNumber: number; branch: string }> }
  | { status: 'error'; detail: string };

const PER_PAGE = 100;

/**
 * Finds the issue's open same-repo factory PR by issue number on any recognized branch prefix (#2253), so a
 * requeue continues on the stranded draft even when the title or prefix drifted. Read-only (`pulls.list` only);
 * fails closed with `error` when the open PR list is longer than `maxPages` pages.
 */
export async function findAdoptablePr(opts: {
  octokit: Pick<Octokit, 'rest'>;
  repo: string;
  issue: number;
  branchPrefix?: string;
  maxPages?: number;
}): Promise<AdoptablePrLookup> {
  const { octokit, repo, issue, branchPrefix, maxPages = 10 } = opts;
  const [owner, name] = repo.split('/');
  const matches: Array<{ prNumber: number; branch: string; headSha: string }> = [];
  try {
    for (let page = 1; page <= maxPages; page++) {
      const { data } = await octokit.rest.pulls.list({ owner, repo: name, state: 'open', per_page: PER_PAGE, page });
      for (const pr of data) {
        const ref = pr.head?.ref ?? '';
        if (factoryBranchIssue(ref, branchPrefix) !== issue) continue;
        if (pr.head?.repo?.full_name?.toLowerCase() !== repo.toLowerCase()) continue;
        matches.push({ prNumber: pr.number, branch: ref, headSha: pr.head.sha });
      }
      if (data.length < PER_PAGE) break;
      if (page === maxPages) {
        return { status: 'error', detail: `open PR list exceeds ${maxPages * PER_PAGE}; adoption skipped` };
      }
    }
  } catch (err) {
    return { status: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
  matches.sort((a, b) => a.prNumber - b.prNumber);
  if (matches.length === 0) return { status: 'absent' };
  if (matches.length === 1) return { status: 'found', ...matches[0] };
  return { status: 'ambiguous', prs: matches.map(({ prNumber, branch }) => ({ prNumber, branch })) };
}
