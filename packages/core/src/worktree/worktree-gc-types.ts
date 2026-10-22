// src/worktree/worktree-gc-types.ts — report, dep and candidate types shared by the worktree GC files.

import type { Octokit } from '@octokit/rest';

import type { EventKind } from '../events/kinds.js';
import type { WorktreeSandbox } from '../utils/microvm.js';

export type GcReason =
  | 'merged'
  | 'remote-gone'
  | 'ttl-expired'
  | 'issue-closed'
  | 'issue-parked'
  | 'issue-decomposed'
  | 'issue-not-found'
  | 'no-active-claim';

/** GitHub's verdict on a candidate branch's PR(s), read via pulls.list (state=all,
 *  head=owner:branch). `null` means "no verdict" (no client/repo, or the query failed) —
 *  which must always fall back to the #639 local-evidence rules. */
export type GcHeadPrState = 'open' | 'merged' | 'closed' | 'none';

export interface WorktreeListEntry {
  path: string;
  head: string | null;
  branch: string | null;
}

export interface GcCandidate {
  path: string;
  branch: string | null;
  ageDays: number;
  reason: GcReason;
  scrubbedFiles: string[];
  /** True when the candidate's local branch was force-deleted after removal. False when the
   *  reason was not branch-reapable, when the candidate was detached, when this was a dry run,
   *  or when `git branch -D` failed (a warn is logged in that last case). */
  branchDeleted: boolean;
  /** Set at decision time for the issue-driven reasons (`issue-closed` / `issue-parked`): true
   *  only when the branch's content is provably on the remote (a PR ever existed, the remote
   *  branch is live, or the tip is an ancestor of origin/main). An unpushed parked attempt's
   *  branch stays as its only handle. */
  branchReapable?: boolean;
  /** `'remove'` for every hard-evidence reason (merge/remote/ttl/issue-disposition proof).
   *  `'quarantine'` for the two heuristic reasons (`issue-not-found` / `no-active-claim`, #1355)
   *  that carry no merge/ancestry proof: the worktree is relocated under the quarantine
   *  directory instead of deleted, and its branch is never force-deleted (see ADR, this PR). */
  action: 'remove' | 'quarantine';
  /** Set only in real mode, only for a `'quarantine'` action, only once the move succeeds — the
   *  path the worktree was relocated to. Absent for `'remove'`, for dry-run, and when the move
   *  itself failed (the worktree is then left in place; see the `warn` log for the failure). */
  quarantinedTo?: string;
}

/** A factory-owned worktree whose lane-branch issue number could not be confirmed to exist on
 *  GitHub. Dry-run surfaces every such candidate here regardless of its other GcReason evidence
 *  (see ADR-0088); real mode instead quarantines it via `removed`/`GcReason.issue-not-found`
 *  (only when no hard-evidence reason already claimed it — see ADR, this PR). */
export interface Issue404Candidate {
  path: string;
  branch: string | null;
  issue: number;
}

/** A factory-owned worktree whose branch's PR is merged or closed but whose owning issue has no
 *  active `factory:claimed-by:*` label. Dry-run surfaces every such candidate here regardless of
 *  its other GcReason evidence; real mode instead quarantines it via
 *  `removed`/`GcReason.no-active-claim` (only when no hard-evidence reason already claimed it —
 *  see ADR, this PR). */
export interface NoActiveClaimCandidate {
  path: string;
  branch: string | null;
  issue: number;
  prState: 'merged' | 'closed';
}

/** A candidate GC would otherwise reap on hard issue evidence but kept to protect local work —
 *  surfaced so the operator sees why it survived (#1756). */
export interface GcHeldCandidate {
  path: string;
  branch: string | null;
  issue: number;
  why: string;
}

/** A worktree kept by a worktree-keeps.json record (#3316). */
export interface GcKeptCandidate {
  path: string;
  branch: string | null;
  issue: number;
  reason: string;
}

export interface GcReport {
  removed: GcCandidate[];
  kept: number;
  dryRun: boolean;
  /** Dry-run only: factory-owned candidates whose lane issue number 404'd on GitHub — a strong
   *  signal the worktree was created for an issue that never existed. Never read by, or written
   *  from, GcReason/BRANCH_REAPABLE_REASONS. Always [] outside dry-run — real mode's equivalent
   *  signal shows up as a `removed` entry with `reason: 'issue-not-found'` instead. */
  issueNotFound: Issue404Candidate[];
  /** Dry-run only: factory-owned candidates whose lane issue lookup threw a non-404 error (rate
   *  limit, network failure) — "couldn't check," never conflated with issueNotFound's "confirmed
   *  gone." Always [] outside dry-run; real mode never acts on an unverifiable lookup (fail-safe:
   *  keeps the worktree). */
  issueUnverifiable: Issue404Candidate[];
  /** Dry-run only: factory-owned candidates whose branch's PR is merged or closed and whose
   *  owning issue carries no active `factory:claimed-by:*` label — the lane finished (or was
   *  abandoned) without releasing its worktree. Fail-safe: any doubt (no client/repo, lookup
   *  error, unresolved issue number) means "not flagged." Never read by, or written from,
   *  GcReason/BRANCH_REAPABLE_REASONS. Always [] outside dry-run — real mode's equivalent signal
   *  shows up as a `removed` entry with `reason: 'no-active-claim'` instead. */
  noActiveClaim: NoActiveClaimCandidate[];
  /** Decomposed-parent worktrees (`factory:decomposed`) kept because they are dirty, hold
   *  unpushed commits, or could not be verified (#1756). Populated in dry-run and real mode;
   *  every entry is also counted in `kept`. */
  held: GcHeldCandidate[];
  /** Worktrees kept by a worktree-keeps.json record (#3316); also counted in kept. */
  keptByRecord?: GcKeptCandidate[];
  /** Parked, unkept worktrees held because they have untracked files (#3318); also counted in kept. */
  heldUntracked?: GcHeldCandidate[];
}

export interface SweepDeps {
  runCommand?: (cmd: string, opts?: { cwd?: string }) => Promise<{ stdout: string }>;
  now?: () => number;
  log?: (type: EventKind, msg: string) => void;
  /** When present (with opts.repo), merged/close status is sourced from GitHub; absent or failing ⇒ local evidence only. */
  octokit?: Pick<Octokit, 'rest'>;
  /** The repo's current docker-sandbox descriptor (runtime + authPaths), or undefined for every
   *  other runtime. A reaped candidate may have been provisioned under a different runtime than
   *  today's config, but removeMicroVm is a no-op unless `runtime === 'docker-sandbox'` and the
   *  named VM exists, so passing today's descriptor for every candidate is safe and idempotent. */
  sandbox?: WorktreeSandbox;
  /** Dedup tracker for resolveIssueDisposition's lookup-failure warning (see IssueWarnDedup).
   *  Defaults to a module-level singleton shared across every sweep in the process; tests should
   *  inject a fresh instance to avoid bleeding suppression state across cases. */
  issueWarnDedup?: IssueWarnDedup;
}

/** Dedupes resolveIssueDisposition's lookup-failure warning across repeated sweeps — the factory
 *  loop calls sweepWorktrees every iteration, and a worktree tied to a nonexistent issue number
 *  fails that lookup on every one of them. The first failure for a given issue since the last
 *  reconcile-clear warns in full; every following one folds into a one-line "suppressed N"
 *  summary instead of repeating the same text. `reconcile()` drops an issue's tracking once it's
 *  no longer among the sweep's candidates, so a later re-appearance (or a different worktree
 *  reusing the number) warns in full again. Keyed by issue number, not by worktree path, since
 *  the failing lookup is per-issue (see ADR, this PR). */
export class IssueWarnDedup {
  private readonly counts = new Map<number, number>();

  /** Records one occurrence for `issue`. Returns true the first time since the last
   *  reconcile-clear (caller should log the full warning), false thereafter. */
  record(issue: number): boolean {
    const count = (this.counts.get(issue) ?? 0) + 1;
    this.counts.set(issue, count);
    return count === 1;
  }

  /** Occurrences suppressed for `issue` since its last full warning (0 before the second one). */
  suppressedCount(issue: number): number {
    return Math.max(0, (this.counts.get(issue) ?? 0) - 1);
  }

  /** Drops tracking for every issue not in `activeIssues` — call once per sweep with the issue
   *  numbers still present among that sweep's candidates. */
  reconcile(activeIssues: ReadonlySet<number>): void {
    for (const issue of this.counts.keys()) {
      if (!activeIssues.has(issue)) this.counts.delete(issue);
    }
  }
}

export const defaultIssueWarnDedup = new IssueWarnDedup();
