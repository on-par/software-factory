import type { Octokit } from '@octokit/rest';
import { factoryBranchIssue } from '../utils/index.js';
import { lookupOpenPrs } from './pr-lookup.js';

export * from './pr-lookup.js';

export type AdoptablePrLookup =
  | { status: 'found'; prNumber: number; branch: string; headSha: string }
  | { status: 'absent' }
  | { status: 'ambiguous'; prs: Array<{ prNumber: number; branch: string }> }
  | { status: 'error'; detail: string };

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
  const { octokit, repo, issue, branchPrefix, maxPages } = opts;
  const lookup = await lookupOpenPrs({
    octokit,
    repo,
    maxPages,
    matches: (pr) => factoryBranchIssue(pr.head?.ref ?? '', branchPrefix) === issue,
  });
  switch (lookup.status) {
    case 'none':
      return { status: 'absent' };
    case 'ambiguous':
      return { status: 'ambiguous', prs: lookup.prs.map(({ prNumber, branch }) => ({ prNumber, branch })) };
    case 'error':
      return {
        status: 'error',
        detail: lookup.detail.startsWith('open PR list exceeds') ? `${lookup.detail}; adoption skipped` : lookup.detail,
      };
    case 'found':
      return lookup;
  }
}
