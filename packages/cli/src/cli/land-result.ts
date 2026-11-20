import type { Octokit } from '@octokit/rest';
import { listAllCheckRuns } from '@on-par/factory-core/internal';

import { CiFailedError } from './land-errors.js';
import { latestPrForBranch } from './land-merged.js';
import { LandConflictError, LandFailureError, isCiNotGreen } from './land-pr.js';
import type { LandResultJson } from './land-result-contract.js';

export type LandResultKind = 'merged' | 'checks_pending' | 'checks_failed' | 'conflicting' | 'closed';

export const LAND_CHECKS_PENDING_EXIT_CODE = 75;

export class LandNoOpenPrError extends LandFailureError {
  constructor(
    message: string,
    readonly branches: readonly string[],
  ) {
    super(message, 1);
  }
}

export function landResultKind(err: unknown): LandResultKind | undefined {
  if (err === undefined) return 'merged';
  if (isCiNotGreen(err)) return 'checks_pending';
  if (err instanceof CiFailedError) return 'checks_failed';
  if (err instanceof LandConflictError) return 'conflicting';
  return undefined;
}

const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

function names(list: readonly (string | null | undefined)[]): string[] {
  return [...new Set(list.filter((n): n is string => typeof n === 'string' && n !== ''))].sort();
}

type NamedChecks = { pending: string[]; failed: string[] };

async function readCheckRunNames(octokit: Octokit, owner: string, repo: string, sha: string): Promise<NamedChecks> {
  const runs = (await listAllCheckRuns(octokit, owner, repo, sha, 100, 10)) as {
    name?: string;
    status?: string;
    conclusion?: string | null;
  }[];
  return {
    pending: runs.filter((r) => r.status !== 'completed').map((r) => r.name ?? ''),
    failed: runs
      .filter((r) => r.status === 'completed' && !PASSING_CONCLUSIONS.has(r.conclusion ?? ''))
      .map((r) => r.name ?? ''),
  };
}

async function readStatusNames(octokit: Octokit, owner: string, repo: string, sha: string): Promise<NamedChecks> {
  const { data } = await octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref: sha, per_page: 100 });
  const statuses = data.statuses ?? [];
  return {
    pending: statuses.filter((s) => s.state === 'pending').map((s) => s.context ?? ''),
    failed: statuses.filter((s) => s.state === 'failure' || s.state === 'error').map((s) => s.context ?? ''),
  };
}

async function readCheckNames(octokit: Octokit, owner: string, repo: string, headSha: string): Promise<NamedChecks> {
  const empty: NamedChecks = { pending: [], failed: [] };
  const [runs, statuses] = await Promise.all([
    readCheckRunNames(octokit, owner, repo, headSha).catch(() => empty),
    readStatusNames(octokit, owner, repo, headSha).catch(() => empty),
  ]);
  return {
    pending: names([...runs.pending, ...statuses.pending]),
    failed: names([...runs.failed, ...statuses.failed]),
  };
}

export async function readLandResult(
  octokit: Octokit,
  ghRepo: string,
  result: LandResultKind,
  prNumber: number,
): Promise<LandResultJson> {
  const [owner, repo] = ghRepo.split('/') as [string, string];
  let headSha: string | null = null;
  let mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' = 'UNKNOWN';
  try {
    const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    headSha = data.head?.sha ?? null;
    if (data.mergeable === true) mergeable = 'MERGEABLE';
    else if (data.mergeable === false) mergeable = 'CONFLICTING';
  } catch {
    headSha = null;
  }
  const base = { schemaVersion: 1 as const };
  if (result === 'checks_pending' || result === 'checks_failed') {
    const found = headSha ? await readCheckNames(octokit, owner, repo, headSha) : { pending: [], failed: [] };
    if (result === 'checks_pending') {
      return { ...base, result, pr: prNumber, headSha, pending: found.pending, mergeable };
    }
    return { ...base, result, pr: prNumber, headSha, failed: found.failed, mergeable };
  }
  return { ...base, result, pr: prNumber, headSha, mergeable };
}

async function emitLandResult(opts: Parameters<typeof printLandResult>[0]): Promise<void> {
  const write = opts.write ?? ((line: string) => console.log(line));
  let kind = landResultKind(opts.error);
  let prNumber = opts.prNumber;
  if (opts.error instanceof LandNoOpenPrError) {
    const [owner, repo] = opts.ghRepo.split('/') as [string, string];
    for (const branch of opts.error.branches) {
      const found = await latestPrForBranch(opts.octokit, owner, repo, branch);
      if (found) {
        kind = 'closed';
        prNumber = found.number;
        break;
      }
    }
  }
  if (kind === undefined || prNumber === undefined) return;
  write(JSON.stringify(await readLandResult(opts.octokit, opts.ghRepo, kind, prNumber)));
}

export async function printLandResult(opts: {
  json: boolean;
  octokit: Octokit;
  ghRepo: string;
  prNumber?: number;
  error?: unknown;
  write?: (line: string) => void;
}): Promise<void> {
  if (!opts.json) return;
  await emitLandResult(opts).catch(() => undefined);
}
