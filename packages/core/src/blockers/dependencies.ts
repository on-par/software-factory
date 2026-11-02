// src/blockers/dependencies.ts — thin client for GitHub's native issue dependencies
// ("blocked by") REST endpoints (#2316).
//
// Only the same-repo list and add operations the blocker filer needs. Errors propagate;
// a listing that does not parse to an array fails closed (ADR-0018) rather than reading
// as "no blockers".

import type { Octokit } from '@octokit/rest';

export interface DependencyClientDeps {
  octokit: Octokit;
  repo: string; // 'owner/name'
}

export interface BlockedByItem {
  number: number;
  state: 'open' | 'closed';
  stateReason: string | null;
  repository: string; // 'owner/name'
}

interface RawBlockedByItem {
  number: number;
  state?: string;
  state_reason?: string | null;
  repository?: { full_name?: string };
  repository_url?: string;
}

function repositoryOf(item: RawBlockedByItem, fallback: string): string {
  if (item.repository?.full_name !== undefined) {
    return item.repository.full_name;
  }
  if (item.repository_url !== undefined) {
    return item.repository_url.split('/').slice(-2).join('/');
  }
  return fallback;
}

/** Lists the issues that block `issue` (GET .../dependencies/blocked_by). */
export async function listBlockedBy(deps: DependencyClientDeps, issue: number): Promise<BlockedByItem[]> {
  const [owner, repo] = deps.repo.split('/') as [string, string];
  const items: BlockedByItem[] = [];
  for (let page = 1; ; page++) {
    const response = await deps.octokit.request(
      'GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by',
      { owner, repo, issue_number: issue, per_page: 100, page },
    );
    const data: unknown = response.data;
    if (!Array.isArray(data)) throw new Error('blocked_by listing did not return an array');
    items.push(
      ...(data as RawBlockedByItem[]).map((item) => ({
        number: item.number,
        state: item.state === 'closed' ? ('closed' as const) : ('open' as const),
        stateReason: item.state_reason ?? null,
        repository: repositoryOf(item, deps.repo),
      })),
    );
    if (data.length < 100) return items;
  }
}

/**
 * Marks `issue` as blocked by another issue (POST .../dependencies/blocked_by).
 * `blockerIssueId` is the blocker's database id (`issue.id`), NOT its issue number.
 */
export async function addBlockedBy(deps: DependencyClientDeps, issue: number, blockerIssueId: number): Promise<void> {
  const [owner, repo] = deps.repo.split('/') as [string, string];
  await deps.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by', {
    owner,
    repo,
    issue_number: issue,
    issue_id: blockerIssueId,
  });
}
