// src/run/park-comment.ts — upsert one issue comment with the park state behind a hidden factory-issue-state marker (#2314, ADR-0130)
//
// Every runIssue park edits one comment per issue in place (#728). Anyone can post the marker, so only a
// marker comment written by the authenticated identity is trusted (same rule as readiness/slice-plan-github.ts).

import type { Octokit } from '@octokit/rest';

import { fenceExcerpt, stripHiddenContent } from '../filing/sanitize.js';
import { readWorktreeHead } from './ci-suppression-guard.js';
import type { ParkReason } from './outcome.js';

export const ISSUE_STATE_MARKER_VERSION = 'v1';

export interface ParkCommentInput {
  issue: number;
  reason: ParkReason;
  message: string;
  runId: string;
  branch: string;
  lane?: string;
  parkSha?: string;
  blockers?: readonly number[];
  autoUnparks?: number;
  status?: string;
}

/** `reason` is a plain string because the parser reads untrusted text. */
export interface ParkState {
  reason: string;
  lane?: string;
  runId?: string;
  branch?: string;
  parkSha?: string;
  blockers: number[];
  /** Times the blocked-park poller re-queued this issue; 0 when the line is absent or malformed. */
  autoUnparks: number;
  status?: string;
}

export interface ParkStateComment {
  id: number;
  body: string;
}

const PAGE_SIZE = 100;
const STATE_HEADING = '**Park state**';
const MARKER_RE = new RegExp(`<!-- factory-issue-state ${ISSUE_STATE_MARKER_VERSION} issue:(\\d+) -->`);

export function issueStateMarker(issue: number): string {
  return `<!-- factory-issue-state ${ISSUE_STATE_MARKER_VERSION} issue:${issue} -->`;
}

const PARK_HINTS: Record<ParkReason, string> = {
  fail: 'fix the failing checks on the branch or clarify the issue, then run `factory unpark <n>`.',
  blocked:
    'waiting on a filed blocker. The factory resumes it once the blocker closes; run `factory unpark <n>` to retry sooner.',
  escalate: 'a human decision is needed. Answer it on the issue, then run `factory unpark <n>`.',
  timeout: 'a phase timed out. Check the lane log and retry with `factory unpark <n>`.',
  conflict: 'rebase the branch onto main, then run `factory unpark <n>`.',
  'ci-failed': 'fix CI on the PR, then run `factory unpark <n>`.',
  'ci-infra': 'CI infrastructure failed. Re-run CI, then run `factory unpark <n>`.',
  held: 'the same failure parked a prior run. A human must change the approach before `factory unpark <n>`.',
  config: 'fix the named config file and line, then run `factory unpark <n>`.',
};

export function parkUnblockHint(reason: ParkReason, issue: number): string {
  return PARK_HINTS[reason].replaceAll('<n>', String(issue));
}

function clean(v: string): string {
  return stripHiddenContent(v)
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

export function renderParkComment(input: ParkCommentInput): string {
  const blockers = input.blockers ?? [];
  const stateLines = [
    `reason: ${clean(input.reason)}`,
    `lane: ${(input.lane && clean(input.lane)) || '-'}`,
    `run: ${clean(input.runId)}`,
    `branch: ${clean(input.branch)}`,
    `park-sha: ${(input.parkSha && clean(input.parkSha)) || '-'}`,
    `blockers: ${blockers.length > 0 ? blockers.map((n) => `#${n}`).join(', ') : '-'}`,
  ];
  if (input.autoUnparks !== undefined && input.autoUnparks > 0) stateLines.push(`auto-unparks: ${input.autoUnparks}`);
  if (input.status) stateLines.push(`status: ${clean(input.status)}`);
  const stateBlock = stateLines.join('\n');
  return [
    '### Factory park state',
    '',
    STATE_HEADING,
    '',
    fenceExcerpt(stateBlock),
    '',
    '**Why it parked**',
    '',
    fenceExcerpt(stripHiddenContent(input.message)),
    '',
    `**What unblocks this:** ${parkUnblockHint(input.reason, input.issue)}`,
    '',
    issueStateMarker(input.issue),
  ].join('\n');
}

function findStateFence(body: string): { lines: string[]; open: number; close: number } | null {
  const lines = body.split('\n');
  const heading = lines.indexOf(STATE_HEADING);
  if (heading === -1) return null;
  const isFence = (l: string): boolean => /^`{5,}$/.test(l);
  const open = lines.findIndex((l, i) => i > heading && isFence(l));
  if (open === -1) return null;
  const close = lines.indexOf(lines[open], open + 1);
  if (close === -1) return null;
  return { lines, open, close };
}

function parseStateBlock(body: string): ParkState | null {
  const fence = findStateFence(body);
  if (fence === null) return null;
  const { lines, open, close } = fence;
  const values = new Map<string, string>();
  for (const line of lines.slice(open + 1, close)) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    values.set(line.slice(0, sep).trim(), line.slice(sep + 1).trim());
  }
  const reason = values.get('reason');
  if (!reason) return null;
  const optional = (key: string): string | undefined => {
    const v = values.get(key);
    return v === undefined || v === '' || v === '-' ? undefined : v;
  };
  const blockers = [...(values.get('blockers') ?? '').matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  const rawAutoUnparks = values.get('auto-unparks') ?? '';
  const autoUnparks =
    /^\d+$/.test(rawAutoUnparks) && Number.isSafeInteger(Number(rawAutoUnparks)) ? Number(rawAutoUnparks) : 0;
  return {
    reason,
    lane: optional('lane'),
    runId: optional('run'),
    branch: optional('branch'),
    parkSha: optional('park-sha'),
    blockers,
    autoUnparks,
    status: optional('status'),
  };
}

export interface ParkCommentPatch {
  reason?: ParkReason;
  status?: string;
  autoUnparks?: number;
}

/** Rewrites the state block (and the unblock hint on a reason change) in place; null when there is no state block. */
export function patchParkComment(body: string, issue: number, patch: ParkCommentPatch): string | null {
  const fence = findStateFence(body);
  if (fence === null) return null;
  const { lines, open, close } = fence;
  const inner = lines.slice(open + 1, close);
  const setLine = (key: string, value: string): void => {
    const at = inner.findIndex((l) => l.slice(0, Math.max(l.indexOf(':'), 0)).trim() === key);
    if (at === -1) inner.push(`${key}: ${value}`);
    else inner[at] = `${key}: ${value}`;
  };
  if (patch.reason !== undefined) setLine('reason', clean(patch.reason));
  if (patch.status !== undefined) setLine('status', clean(patch.status));
  if (patch.autoUnparks !== undefined) setLine('auto-unparks', String(patch.autoUnparks));
  const out = [...lines.slice(0, open + 1), ...inner, ...lines.slice(close)];
  if (patch.reason !== undefined) {
    const hint = out.findIndex((l) => l.startsWith('**What unblocks this:**'));
    if (hint !== -1) out[hint] = `**What unblocks this:** ${parkUnblockHint(patch.reason, issue)}`;
  }
  return out.join('\n');
}

/** Lowest-id marked comment decides; null when none, or when its state block is unreadable. */
export function readParkState(comments: readonly ParkStateComment[], issue?: number): ParkState | null {
  const marked = comments
    .filter((c) => {
      const m = MARKER_RE.exec(c.body);
      return m !== null && (issue === undefined || Number(m[1]) === issue);
    })
    .sort((a, b) => a.id - b.id);
  if (marked.length === 0) return null;
  return parseStateBlock(marked[0].body);
}

/** The lowest-id marker comment written by the authenticated user, or undefined. */
export async function findOwnParkComment(deps: {
  octokit: Octokit;
  repo: string;
  issue: number;
}): Promise<ParkStateComment | undefined> {
  const { octokit, repo, issue } = deps;
  const [owner, name] = repo.split('/');
  const marker = issueStateMarker(issue);
  const { data: me } = await octokit.rest.users.getAuthenticated();
  let existing: ParkStateComment | undefined;
  for (let page = 1; ; page++) {
    const { data } = await octokit.rest.issues.listComments({
      owner,
      repo: name,
      issue_number: issue,
      per_page: PAGE_SIZE,
      page,
    });
    for (const comment of data) {
      const body = comment.body ?? '';
      if (comment.user?.id !== me.id || !body.includes(marker)) continue;
      if (existing === undefined || comment.id < existing.id) existing = { id: comment.id, body };
    }
    if (data.length < PAGE_SIZE) break;
  }
  return existing;
}

export async function upsertParkComment(deps: {
  octokit: Octokit;
  repo: string;
  input: ParkCommentInput;
}): Promise<{ commentId: number; created: boolean }> {
  const { octokit, repo, input } = deps;
  const [owner, name] = repo.split('/');
  const existing = await findOwnParkComment({ octokit, repo, issue: input.issue });
  const autoUnparks =
    input.autoUnparks ?? (existing === undefined ? 0 : (readParkState([existing], input.issue)?.autoUnparks ?? 0));
  const body = renderParkComment({ ...input, autoUnparks });
  if (existing !== undefined) {
    await octokit.rest.issues.updateComment({ owner, repo: name, comment_id: existing.id, body });
    return { commentId: existing.id, created: false };
  }
  const { data } = await octokit.rest.issues.createComment({ owner, repo: name, issue_number: input.issue, body });
  return { commentId: data.id, created: true };
}

/** Never throws: a GitHub or git failure comes back as `{ ok: false, error }`. */
export async function publishParkComment(deps: {
  octokit: Octokit;
  repo: string;
  worktree?: string;
  input: Omit<ParkCommentInput, 'parkSha'>;
  readHead?: (worktree: string) => Promise<string>;
}): Promise<{ ok: true; commentId: number; created: boolean } | { ok: false; error: string }> {
  const { octokit, repo, worktree, input, readHead = readWorktreeHead } = deps;
  let parkSha: string | undefined;
  if (worktree) {
    try {
      parkSha = (await readHead(worktree)) || undefined;
    } catch {
      parkSha = undefined;
    }
  }
  try {
    const result = await upsertParkComment({ octokit, repo, input: { ...input, parkSha } });
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
