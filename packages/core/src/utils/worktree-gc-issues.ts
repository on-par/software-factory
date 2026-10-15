// GitHub issue lookups worktree-gc consults before reaping a lane worktree (split out of worktree-gc.ts).
import type { EventKind } from '../events/kinds.js';
import { CLAIMED_BY_LABEL_PREFIX, DECOMPOSED_LABEL, PARKED_LABEL } from '../queue/github-queue.js';
import { findStaleClaims } from '../queue/stale-claims.js';
import type { IssueWarnDedup, SweepDeps } from './worktree-gc.js';

/** The owning issue's verdict on a lane worktree. `null` means "no verdict" (no client/repo,
 *  or the query failed) and must always fall back to the PR-state/local-evidence rules. */
export type IssueDisposition = 'reap-closed' | 'reap-parked' | 'reap-decomposed' | 'keep-claimed' | 'keep';

/** GitHub's verdict on the owning issue. A closed issue and a factory:parked label both mean
 *  the lane is finished-or-parked and its clean checkout is redundant (see ADR, this PR). */
export async function resolveIssueDisposition(
  octokit: SweepDeps['octokit'],
  repo: string | undefined,
  issue: number,
  log: (type: EventKind, msg: string) => void,
  issueWarnDedup: IssueWarnDedup,
): Promise<IssueDisposition | null> {
  if (!octokit || !repo) return null;
  const [owner, repoName] = repo.split('/');
  try {
    const { data } = await octokit.rest.issues.get({ owner, repo: repoName, issue_number: issue });
    if (data.state === 'closed') return 'reap-closed';
    const labels = new Set((data.labels ?? []).map((l) => (typeof l === 'string' ? l : (l?.name ?? ''))));
    // An open issue with a live claim is being worked by some lane/run right now (#2964): its
    // worktree is never reaped or quarantined, whatever its PR history or age. A lapsed lease is
    // stale (findStaleClaims) and does not protect.
    if (
      [...labels].some((name) => name.startsWith(CLAIMED_BY_LABEL_PREFIX)) &&
      findStaleClaims([{ number: issue, labels: [...labels] }]).length === 0
    ) {
      return 'keep-claimed';
    }
    if (labels.has(PARKED_LABEL)) return 'reap-parked';
    if (labels.has(DECOMPOSED_LABEL)) return 'reap-decomposed';
    return 'keep';
  } catch (err: any) {
    if (issueWarnDedup.record(issue)) {
      log(
        'warn',
        `worktree-gc: GitHub issue query failed for #${issue} (${err?.message ?? String(err)}) — using PR/local evidence only`,
      );
    } else {
      log(
        'warn',
        `worktree-gc: GitHub issue query failed for #${issue} — suppressed ${issueWarnDedup.suppressedCount(issue)} repeated warning(s) (using PR/local evidence only)`,
      );
    }
    return null;
  }
}

/** The lane issue's existence on GitHub, checked only for worktree-gc's dry-run report.
 *  'not-configured' (no client/repo) and 'error' (the call threw anything but a 404) both mean
 *  "no verdict" but are reported differently: 'error' surfaces as unverifiable so a rate-limit
 *  or network blip is never mistaken for a confirmed-gone issue. */
export async function resolveIssueExistence(
  octokit: SweepDeps['octokit'],
  repo: string | undefined,
  issue: number,
  log: (type: EventKind, msg: string) => void,
): Promise<'exists' | 'not-found' | 'error' | 'not-configured'> {
  if (!octokit || !repo) return 'not-configured';
  const [owner, repoName] = repo.split('/');
  try {
    await octokit.rest.issues.get({ owner, repo: repoName, issue_number: issue });
    return 'exists';
  } catch (err: any) {
    if (err?.status === 404) return 'not-found';
    log(
      'warn',
      `worktree-gc: GitHub issue existence check failed for #${issue} (${err?.message ?? String(err)}) — reporting as unverifiable`,
    );
    return 'error';
  }
}

/** Whether the lane issue carries an active, unexpired claim, checked only for worktree-gc's
 *  dry-run report. A `factory:claimed-by:*` label alone is not enough (#1501): if the issue also
 *  carries a `factory:claim-expires:*` lease label and that lease has lapsed, `findStaleClaims`
 *  (the same primitive the queue's own reconcile uses, ADR-0104/#1506) reads it as unclaimed
 *  immediately — no separate release step, and no host-pid/hostname evidence anywhere. Fail-safe:
 *  no client/repo, or a lookup error, both resolve to 'unknown' — never conflated with a
 *  confirmed 'unclaimed' verdict. */
export async function resolveActiveClaim(
  octokit: SweepDeps['octokit'],
  repo: string | undefined,
  issue: number,
  log: (type: EventKind, msg: string) => void,
): Promise<'claimed' | 'unclaimed' | 'unknown'> {
  if (!octokit || !repo) return 'unknown';
  const [owner, repoName] = repo.split('/');
  try {
    const { data } = await octokit.rest.issues.get({ owner, repo: repoName, issue_number: issue });
    const labels = (data.labels ?? []).map((label: any) => (typeof label === 'string' ? label : (label?.name ?? '')));
    if (!labels.some((name: string) => name.startsWith(CLAIMED_BY_LABEL_PREFIX))) return 'unclaimed';
    const stale = findStaleClaims([{ number: issue, labels }]);
    return stale.length > 0 ? 'unclaimed' : 'claimed';
  } catch (err: any) {
    log(
      'warn',
      `worktree-gc: GitHub claim-label check failed for #${issue} (${err?.message ?? String(err)}) — reporting as unknown (not flagged)`,
    );
    return 'unknown';
  }
}
