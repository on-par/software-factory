import type { Octokit } from '@octokit/rest';
import { shortDetail } from './ship-git.js';
import type { PrLookup } from './ship-types.js';

export async function findOpenPR(octokit: Octokit, owner: string, repo: string, branch: string): Promise<PrLookup> {
  try {
    const { data: prs } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open',
      head: `${owner}:${branch}`,
    });
    const prNumber = prs[0]?.number;
    return prNumber === undefined ? { status: 'absent' } : { status: 'found', prNumber };
  } catch (err) {
    return { status: 'error', detail: shortDetail(err) };
  }
}

export async function findMergedPR(octokit: Octokit, owner: string, repo: string, branch: string): Promise<PrLookup> {
  try {
    const { data: prs } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'closed',
      head: `${owner}:${branch}`,
    });
    const prNumber = prs.find((pr) => pr.merged_at != null)?.number;
    return prNumber === undefined ? { status: 'absent' } : { status: 'found', prNumber };
  } catch (err) {
    return { status: 'error', detail: shortDetail(err) };
  }
}

/** A `pulls.create` 422 whose message says the PR already exists — recoverable by re-querying,
 *  unlike every other 422 (e.g. "No commits between ..."), which still propagates (#641). */
export function isPullAlreadyExistsError(err: unknown): boolean {
  const e = err as {
    status?: number;
    message?: string;
    response?: { data?: { errors?: Array<{ message?: string }> } };
  } | null;
  if (e?.status !== 422) return false;
  const messages = [e.message ?? '', ...(e.response?.data?.errors ?? []).map((x) => x?.message ?? '')];
  return messages.some((m) => /already exists/i.test(m));
}
