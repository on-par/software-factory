import type { Octokit } from '@octokit/rest';

export async function commitStatusCount(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<{ total: number; sha: string } | null> {
  try {
    const { data } = await octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref, per_page: 1 });
    return { total: data.total_count ?? data.statuses?.length ?? 0, sha: data.sha ?? ref };
  } catch {
    return null;
  }
}

const DEFAULT_NO_CI_RECENT_COMMITS = 5;

export async function detectNoCiConfigured(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  recentCommits = DEFAULT_NO_CI_RECENT_COMMITS,
): Promise<{ defaultBranch: string } | null> {
  try {
    try {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path: '.github/workflows', ref });
      if (!Array.isArray(data) || data.some((e) => e.type === 'file')) return null;
    } catch (err) {
      if ((err as { status?: number }).status !== 404) return null;
    }
    const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
    const defaultBranch = repoData.default_branch;
    if (typeof defaultBranch !== 'string' || defaultBranch === '') return null;
    const { data: commits } = await octokit.rest.repos.listCommits({
      owner,
      repo,
      sha: defaultBranch,
      per_page: recentCommits,
    });
    if (!commits || commits.length === 0) return null;
    for (const c of commits) {
      const { data: checks } = await octokit.rest.checks.listForRef({ owner, repo, ref: c.sha, per_page: 1 });
      if ((checks.total_count ?? checks.check_runs?.length ?? 0) > 0) return null;
      const { data: status } = await octokit.rest.repos.getCombinedStatusForRef({
        owner,
        repo,
        ref: c.sha,
        per_page: 1,
      });
      if ((status.total_count ?? status.statuses?.length ?? 0) > 0) return null;
    }
    return { defaultBranch };
  } catch {
    return null;
  }
}
