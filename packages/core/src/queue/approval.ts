// Intake approval trust (#1825, ADR-0128). One owner for "is this login a trusted approver?".
// An explicit trustedApprovers list is authoritative (even empty). Unset falls back to repo
// admins via the collaborator-permission API. Any lookup failure is untrusted (fail closed).
// Also owns the content-pinned approval comment (#1826): sha256 of title+body in a hidden v1 marker.
import { createHash } from 'node:crypto';

import type { Octokit } from '@octokit/rest';

import { LANE_LABEL_PREFIX, laneLabel, type EnqueueResult } from './github-queue.js';

/** Narrow port over GitHub's collaborator-permission endpoint. */
export interface CollaboratorPermissionClient {
  getPermissionLevel(input: { owner: string; repo: string; username: string }): Promise<string>;
}

export interface TrustedApproverOptions {
  owner: string;
  repo: string;
  /** `intake.trustedApprovers`. Undefined → admin fallback; any array (even []) is authoritative. */
  trustedApprovers?: readonly string[];
  client: CollaboratorPermissionClient;
}

export async function isTrustedApprover(login: string, options: TrustedApproverOptions): Promise<boolean> {
  const name = login.trim();
  if (name === '') return false;
  const { trustedApprovers, client, owner, repo } = options;
  if (trustedApprovers !== undefined) {
    const wanted = name.toLowerCase();
    return trustedApprovers.some((a) => a.trim().toLowerCase() === wanted);
  }
  try {
    return (await client.getPermissionLevel({ owner, repo, username: name })) === 'admin';
  } catch {
    return false;
  }
}

export function createOctokitCollaboratorPermissionClient(octokit: Octokit): CollaboratorPermissionClient {
  return {
    async getPermissionLevel({ owner, repo, username }) {
      const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });
      return data.permission;
    },
  };
}

export const APPROVAL_MARKER_VERSION = 'v1';

function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

/** sha256 hex of `title + "\n" + body` with CRLF/CR normalized to LF (ADR: approval marker v1). */
export function computeApprovalHash(title: string, body: string | null | undefined): string {
  return createHash('sha256')
    .update(normalizeLineEndings(title) + '\n' + normalizeLineEndings(body ?? ''), 'utf8')
    .digest('hex');
}

function laneSlug(lane: string): string {
  return laneLabel(lane).slice(LANE_LABEL_PREFIX.length);
}

export function approvalMarker(hash: string, lane: string): string {
  return `<!-- factory-approval ${APPROVAL_MARKER_VERSION} sha256:${hash} lane:${laneSlug(lane)} -->`;
}

export function formatApprovalComment(input: { hash: string; lane: string; approver: string }): string {
  const { hash, lane, approver } = input;
  return `${approvalMarker(hash, lane)}\nApproved for factory lane \`${laneSlug(lane)}\` by @${approver} — content sha256 \`${hash.slice(0, 12)}\`.`;
}

/** Narrow port over the GitHub issue endpoints approval needs. */
export interface ApprovalGitHubClient {
  getIssueContent(input: {
    owner: string;
    repo: string;
    issue_number: number;
  }): Promise<{ title: string; body: string | null }>;
  createComment(input: { owner: string; repo: string; issue_number: number; body: string }): Promise<void>;
}

export function createOctokitApprovalClient(octokit: Octokit): ApprovalGitHubClient {
  return {
    async getIssueContent(input) {
      const { data } = await octokit.rest.issues.get(input);
      return { title: data.title, body: data.body ?? null };
    },
    async createComment(input) {
      await octokit.rest.issues.createComment(input);
    },
  };
}

export type ApproveOutcome = 'queued' | 'already-queued' | 'failed';

export interface ApproveIssueResult {
  issue: number;
  outcome: ApproveOutcome;
  /** Set once the approval comment was posted. */
  hash?: string;
  position?: number;
  detail?: string;
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Posts a content-pinned approval comment per issue, then enqueues the commented issues once. Never throws. */
export async function approveIssues(input: {
  owner: string;
  repo: string;
  lane: string;
  issues: readonly number[];
  approver: string;
  client: ApprovalGitHubClient;
  enqueue: (lane: string, issues: readonly number[]) => Promise<EnqueueResult[]>;
}): Promise<ApproveIssueResult[]> {
  const { owner, repo, lane, issues, approver, client, enqueue } = input;
  const results = new Map<number, ApproveIssueResult>();
  const commented: { issue: number; hash: string }[] = [];

  for (const issue of issues) {
    try {
      const { title, body } = await client.getIssueContent({ owner, repo, issue_number: issue });
      const hash = computeApprovalHash(title, body);
      await client.createComment({
        owner,
        repo,
        issue_number: issue,
        body: formatApprovalComment({ hash, lane, approver }),
      });
      commented.push({ issue, hash });
    } catch (err) {
      results.set(issue, { issue, outcome: 'failed', detail: errMessage(err) });
    }
  }

  if (commented.length > 0) {
    const hashes = new Map(commented.map((c) => [c.issue, c.hash]));
    try {
      const outcomes = await enqueue(
        lane,
        commented.map((c) => c.issue),
      );
      for (const r of outcomes) {
        results.set(r.issue, {
          issue: r.issue,
          outcome: r.outcome,
          hash: hashes.get(r.issue),
          ...(r.position === undefined ? {} : { position: r.position }),
          ...(r.detail === undefined ? {} : { detail: r.detail }),
        });
      }
    } catch (err) {
      for (const c of commented) {
        results.set(c.issue, { issue: c.issue, outcome: 'failed', hash: c.hash, detail: errMessage(err) });
      }
    }
  }

  return issues.map((issue) => results.get(issue) ?? { issue, outcome: 'failed', detail: 'no result' });
}
