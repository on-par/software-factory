// packages/core/src/readiness/decompose-guard.ts — pre-flight guard for decomposeOversizedIssue: skip a closed issue,
// and skip when the factory's own proposal is still waiting for a human reply, so PLAN retries stop spamming (#728)
//
// GitHub read failures fail open (verdict `proceed` with a warning): users.getAuthenticated is rejected for
// App installation tokens, and failing closed would permanently disable decomposition there.

import type { Octokit } from '@octokit/rest';

export const DECOMPOSE_PROPOSAL_MARKER = '<!-- factory:decompose-proposal v1 -->';
export const DECOMPOSE_PROPOSAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const LEGACY_HEADING = '## Proposed epic: ';
const PAGE_SIZE = 100;

const errorDetail = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface GuardComment {
  id: number;
  body: string;
  /** ISO timestamp. */
  createdAt: string;
  userId: number | undefined;
  /** 'User' | 'Bot' | 'Organization' */
  userType: string | undefined;
}

export type DecomposeGuardVerdict =
  | { kind: 'proceed'; warning?: string }
  | { kind: 'issue-closed'; reason: string }
  | { kind: 'proposal-pending'; commentId: number; reason: string };

/** True for the versioned marker, or the legacy heading of proposals posted before the marker existed. */
export function isDecomposeProposal(body: string): boolean {
  return body.includes(DECOMPOSE_PROPOSAL_MARKER) || body.trimStart().startsWith(LEGACY_HEADING);
}

/**
 * The factory's latest own proposal, when no human has commented after it and it is still inside
 * the window. Bot-type users and the factory's own comments never count as a human reply.
 */
export function findPendingProposal(
  comments: readonly GuardComment[],
  selfId: number,
  now: Date,
  windowMs: number,
): GuardComment | undefined {
  let latest: GuardComment | undefined;
  for (const comment of [...comments].sort((a, b) => a.id - b.id)) {
    if (comment.userId === selfId && isDecomposeProposal(comment.body)) {
      latest = comment;
    } else if (comment.userId !== undefined && comment.userId !== selfId && comment.userType !== 'Bot') {
      latest = undefined;
    }
  }
  if (latest === undefined) return undefined;
  const age = now.getTime() - Date.parse(latest.createdAt);
  return age <= windowMs ? latest : undefined;
}

/** Never throws. */
export async function checkDecomposeGuard(deps: {
  octokit: Octokit;
  repo: string;
  issue: number;
  now?: Date;
  windowMs?: number;
}): Promise<DecomposeGuardVerdict> {
  const { octokit, repo, issue } = deps;
  const [owner, name] = repo.split('/');

  try {
    const { data } = await octokit.rest.issues.get({ owner, repo: name, issue_number: issue });
    if (data.state === 'closed') {
      return { kind: 'issue-closed', reason: `issue #${issue} is already closed — decomposition skipped` };
    }
  } catch (error) {
    return { kind: 'proceed', warning: `could not read #${issue}'s state (${errorDetail(error)}); decomposing anyway` };
  }

  let selfId: number;
  const comments: GuardComment[] = [];
  try {
    const { data: me } = await octokit.rest.users.getAuthenticated();
    selfId = me.id;
    for (let page = 1; ; page++) {
      const { data } = await octokit.rest.issues.listComments({
        owner,
        repo: name,
        issue_number: issue,
        per_page: PAGE_SIZE,
        page,
      });
      if (!Array.isArray(data)) throw new Error('comment listing did not return an array');
      for (const comment of data) {
        comments.push({
          id: comment.id,
          body: comment.body ?? '',
          createdAt: comment.created_at,
          userId: comment.user?.id,
          userType: comment.user?.type,
        });
      }
      if (data.length < PAGE_SIZE) break;
    }
  } catch (error) {
    return {
      kind: 'proceed',
      warning: `could not list #${issue}'s comments (${errorDetail(error)}); decomposing anyway`,
    };
  }

  const pending = findPendingProposal(
    comments,
    selfId,
    deps.now ?? new Date(),
    deps.windowMs ?? DECOMPOSE_PROPOSAL_WINDOW_MS,
  );
  if (pending !== undefined) {
    return {
      kind: 'proposal-pending',
      commentId: pending.id,
      reason: `a decompose proposal (comment ${pending.id}, ${pending.createdAt}) is already awaiting a human decision on #${issue} — not re-proposing`,
    };
  }
  return { kind: 'proceed' };
}
