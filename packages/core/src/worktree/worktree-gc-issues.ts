// GitHub issue lookups worktree-gc consults before reaping a lane worktree (split out of worktree-gc.ts).
import type { EventKind } from '../events/kinds.js';
import { CLAIMED_BY_LABEL_PREFIX, DECOMPOSED_LABEL, PARKED_LABEL } from '../queue/github-queue.js';
import { findStaleClaims } from '../queue/stale-claims.js';
import type { IssueWarnDedup, SweepDeps } from './worktree-gc-types.js';

/** The owning issue's verdict on a lane worktree. `null` means "no verdict" (no client/repo,
 *  or the query failed) and must always fall back to the PR-state/local-evidence rules. */
export type IssueDisposition = 'reap-closed' | 'reap-parked' | 'reap-decomposed' | 'keep-claimed' | 'keep';

/** One `issues.get` response (or why there is none), fetched once per issue per sweep; the
 *  disposition, existence and claim verdicts are all derived from it. */
export type IssueRecord =
  | { kind: 'ok'; state: string; labels: string[] }
  | { kind: 'not-found'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'not-configured' };

export async function fetchIssueRecord(
  octokit: SweepDeps['octokit'],
  repo: string | undefined,
  issue: number,
  log: (type: EventKind, msg: string) => void,
  issueWarnDedup: IssueWarnDedup,
): Promise<IssueRecord> {
  if (!octokit || !repo) return { kind: 'not-configured' };
  const [owner, repoName] = repo.split('/');
  try {
    const { data } = await octokit.rest.issues.get({ owner, repo: repoName, issue_number: issue });
    const labels = (data.labels ?? []).map((l) => (typeof l === 'string' ? l : (l?.name ?? '')));
    return { kind: 'ok', state: data.state, labels };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    if (issueWarnDedup.record(issue)) {
      log('warn', `worktree-gc: GitHub issue query failed for #${issue} (${message}) — using PR/local evidence only`);
    } else {
      log(
        'warn',
        `worktree-gc: GitHub issue query failed for #${issue} — suppressed ${issueWarnDedup.suppressedCount(issue)} repeated warning(s) (using PR/local evidence only)`,
      );
    }
    return { kind: err?.status === 404 ? 'not-found' : 'error', message };
  }
}

function hasLiveClaim(labels: string[], issue: number): boolean {
  return (
    labels.some((name) => name.startsWith(CLAIMED_BY_LABEL_PREFIX)) &&
    findStaleClaims([{ number: issue, labels }]).length === 0
  );
}

/** The disposition resolveIssueDisposition computes, from an already-fetched record. */
export function dispositionOf(record: IssueRecord, issue: number): IssueDisposition | null {
  if (record.kind !== 'ok') return null;
  if (record.state === 'closed') return 'reap-closed';
  // A lapsed lease is stale (findStaleClaims) and does not protect (#2964).
  if (hasLiveClaim(record.labels, issue)) return 'keep-claimed';
  if (record.labels.includes(PARKED_LABEL)) return 'reap-parked';
  if (record.labels.includes(DECOMPOSED_LABEL)) return 'reap-decomposed';
  return 'keep';
}

export function existenceOf(record: IssueRecord): 'exists' | 'not-found' | 'error' | 'not-configured' {
  if (record.kind === 'ok') return 'exists';
  return record.kind;
}

export function claimOf(record: IssueRecord, issue: number): 'claimed' | 'unclaimed' | 'unknown' {
  if (record.kind !== 'ok') return 'unknown';
  return hasLiveClaim(record.labels, issue) ? 'claimed' : 'unclaimed';
}
