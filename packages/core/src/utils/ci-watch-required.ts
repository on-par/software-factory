import type { Octokit } from '@octokit/rest';
import { classifyRequiredChecks, fetchRequiredContexts, type RequiredChecksState } from './required-checks.js';

interface RunLike {
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
}

export type RequiredWaitingFor = Array<{ name: string; state: 'not reported yet' | 'pending' }>;

export async function resolveRequiredContexts(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string | undefined,
): Promise<string[]> {
  if (!branch) return [];
  try {
    return await fetchRequiredContexts(octokit, { owner, repo, branch });
  } catch {
    return [];
  }
}

export async function readRequiredState(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  required: readonly string[],
  runs: readonly RunLike[],
): Promise<{ rs: RequiredChecksState; statusFailed: boolean; waitingFor: RequiredWaitingFor }> {
  const runLikes = runs.map((r) => ({
    name: r.name ?? '',
    status: r.status ?? null,
    conclusion: r.conclusion ?? null,
  }));
  let statusFailed = false;
  try {
    const { data } = await octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref, per_page: 100 });
    for (const { context, state } of data.statuses ?? []) {
      if ((state === 'failure' || state === 'error') && required.includes(context)) statusFailed = true;
      runLikes.push({
        name: context,
        status: state === 'pending' ? 'in_progress' : 'completed',
        conclusion: state === 'pending' ? null : state,
      });
    }
  } catch {}
  const rs = classifyRequiredChecks(required, runLikes);
  const waitingFor: RequiredWaitingFor = [];
  for (const name of new Set(required)) {
    if (rs.missing.includes(name)) waitingFor.push({ name, state: 'not reported yet' });
    else if (rs.pending.includes(name)) waitingFor.push({ name, state: 'pending' });
  }
  return { rs, statusFailed, waitingFor };
}
