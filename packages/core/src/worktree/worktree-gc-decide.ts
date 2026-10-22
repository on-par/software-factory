// src/worktree/worktree-gc-decide.ts — the pure remove / quarantine / keep decision for one worktree

import type { WorktreeEvidence } from './worktree-gc-evidence.js';
import type { GcReason } from './worktree-gc-types.js';

export interface GcPolicy {
  ttlDays: number;
  dryRun: boolean;
}

export type GcDecision =
  | { action: 'remove' | 'quarantine'; reason: GcReason; branchReapable: boolean }
  | {
      action: 'keep';
      why: 'protected' | 'keep-record' | 'live-claim' | 'held' | 'no-evidence';
      held?: string;
    };

/** Reasons whose real-mode action is `'quarantine'` rather than `'remove'` — the two heuristic
 *  signals (#1355) that carry no merge/ancestry proof, unlike every other `GcReason`. */
export const QUARANTINE_REASONS: ReadonlySet<GcReason> = new Set<GcReason>(['issue-not-found', 'no-active-claim']);

function reap(reason: GcReason, branchReapable: boolean): GcDecision {
  return { action: QUARANTINE_REASONS.has(reason) ? 'quarantine' : 'remove', reason, branchReapable };
}

/** The one keep-record rule (#3316): a record protects the worktree from every removal except a
 *  closed issue with a clean tree. Lane setup/reap pass a null disposition, so a record always holds. */
function keepRecordHolds(
  keep: { reason: string } | null,
  disposition: WorktreeEvidence['disposition'] | null,
  clean: boolean,
): boolean {
  return keep !== null && !(disposition === 'reap-closed' && clean);
}

const KEEP: GcDecision = { action: 'keep', why: 'no-evidence' };

/** Decomposed parent (#1756): reap only a clean, fully-pushed tree with no open PR. Null means
 *  "open PR: fall through to the PR chain". */
function decideDecomposed(e: WorktreeEvidence): GcDecision | null {
  const g = e.git;
  if (e.branch !== null && e.prState === 'open') return null;
  const hold = (held: string): GcDecision => ({ action: 'keep', why: 'held', held });
  if (!g.clean) return hold('decomposed parent has uncommitted changes');
  if (e.head === null) return hold('decomposed parent HEAD could not be resolved');
  if (g.unpushedCount === null) return hold('could not verify decomposed parent is pushed');
  if (g.unpushedCount > 0) return hold(`decomposed parent has ${g.unpushedCount} unpushed commit(s)`);
  return reap('issue-decomposed', g.zeroCommit);
}

/** The PR-state / local-evidence chain (#639). Every inconclusive probe keeps. */
function decideFromPrChain(e: WorktreeEvidence): GcDecision {
  const g = e.git;
  if (e.prState === 'open') return KEEP; // a live PR is authoritative: never remove
  if (e.prState === 'merged') {
    return g.clean && !g.zeroCommit ? reap('merged', false) : KEEP;
  }
  if (e.prState === 'closed') {
    if (!g.clean || g.zeroCommit) return KEEP;
    if (e.head !== null && g.mainTip !== null && g.headIsAncestorOfMain) return reap('merged', false);
    return g.remoteBranch === 'absent' ? reap('remote-gone', false) : KEEP;
  }
  // 'none' or null: no GitHub verdict, local evidence only.
  if (
    g.clean &&
    e.head &&
    g.mainTip !== null &&
    e.head !== g.mainTip &&
    g.headIsAncestorOfMain &&
    g.priorPush &&
    !g.zeroCommit
  ) {
    return reap('merged', false);
  }
  if (g.clean && g.remoteBranch === 'absent' && g.priorPush && !g.zeroCommit) return reap('remote-gone', false);
  return KEEP;
}

/** Real-mode-only heuristic tier (#1355): quarantine, never delete. */
function decideHeuristic(e: WorktreeEvidence, policy: GcPolicy): GcDecision {
  if (policy.dryRun || (e.branch !== null && e.prState === 'open') || !e.git.clean || e.issue === null) return KEEP;
  if (e.existence === 'not-found') return reap('issue-not-found', false);
  if (e.branch !== null && (e.prState === 'merged' || e.prState === 'closed') && e.claim === 'unclaimed') {
    return reap('no-active-claim', false);
  }
  return KEEP;
}

/** Decides remove / quarantine / keep for one worktree from its evidence alone. Rule order:
 *  protected, keep record, live claim, TTL, issue disposition, decomposed hold, PR/local chain,
 *  heuristic quarantine. */
export function decideWorktree(e: WorktreeEvidence, policy: GcPolicy): GcDecision {
  const g = e.git;
  if (e.protected) return { action: 'keep', why: 'protected' };
  // A keep record protects the worktree from every reason except a closed issue with a clean tree.
  if (keepRecordHolds(e.keep, e.disposition, g.clean)) return { action: 'keep', why: 'keep-record' };
  // A live claim outranks every reap tier, TTL included (#2964).
  if (e.disposition === 'keep-claimed') return { action: 'keep', why: 'live-claim' };
  if (e.ageDays > policy.ttlDays && !e.keep) return reap('ttl-expired', false);

  if ((e.disposition === 'reap-parked' || e.disposition === 'reap-closed') && g.clean) {
    const branchReapable =
      e.branch !== null &&
      (e.prState === 'open' ||
        e.prState === 'merged' ||
        e.prState === 'closed' ||
        g.remoteBranch === 'present' ||
        g.headIsAncestorOfMain);
    return reap(e.disposition === 'reap-parked' ? 'issue-parked' : 'issue-closed', branchReapable);
  }
  if (e.disposition === 'reap-decomposed' && e.issue !== null) {
    const decomposed = decideDecomposed(e);
    if (decomposed) return decomposed;
  }
  if (e.branch !== null) {
    const chain = decideFromPrChain(e);
    if (chain.action !== 'keep') return chain;
  }
  return decideHeuristic(e, policy);
}

/** What a lane's own removal (setupWorktree's replace step, reapLaneWorktree) knows about the worktree. */
export interface LaneRemovalEvidence {
  keep: { issue: number; reason: string } | null;
  /** No modified tracked files; null when the probe failed. */
  clean: boolean | null;
}

export type LaneRemovalDecision =
  { action: 'remove' } | { action: 'keep'; why: 'keep-record' | 'dirty' | 'unverified' };

/** Remove / keep for a lane removing its own worktree. Rule order: keep record, unverified, dirty. */
export function decideLaneRemoval(e: LaneRemovalEvidence): LaneRemovalDecision {
  if (keepRecordHolds(e.keep, null, e.clean === true)) return { action: 'keep', why: 'keep-record' };
  if (e.clean === null) return { action: 'keep', why: 'unverified' };
  if (!e.clean) return { action: 'keep', why: 'dirty' };
  return { action: 'remove' };
}
