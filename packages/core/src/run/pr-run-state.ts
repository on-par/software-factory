// packages/core/src/run/pr-run-state.ts — a run's resumable state in a factory-owned PR comment (#3909, ADR-0174)
//
// A disposable host loses `.factory/state` with the container. The run persists the state it needs to resume
// (rework counters, handled review ids, status, spec summary) in one hidden comment on its open PR. Anyone can post
// the marker, so only a comment by the authenticated identity whose sha256 digest matches is trusted.

import { createHash } from 'node:crypto';

import type { Octokit } from '@octokit/rest';
import { z } from 'zod';

import { redactSecrets } from '../filing/redact.js';
import type { RunStatus } from '../types/index.js';
import {
  isOwnComment,
  resolveSelfIdentity,
  type SelfIdentity,
  type SelfIdentityOctokit,
} from '../utils/github-identity.js';
import { workKeyFromIssue, type WorkKey } from '../work/work-key.js';
import { upsertMarkerComment } from './park-comment.js';

export const PR_RUN_STATE_VERSION = 'v1';
export const PR_RUN_STATUSES = ['building', 'awaiting-ci', 'awaiting-review', 'parked'] as const;
export type PrRunStatus = (typeof PR_RUN_STATUSES)[number];
/** Why SHIP left the PR as a draft (#3932): 'ci-pending' lets the sweep land it, 'requested' is intentional. */
export const PR_DRAFT_REASONS = ['ci-pending', 'requested'] as const;

export const SPEC_SUMMARY_MAX = 1000;
export const MAX_HANDLED_IDS = 200;
export const MAX_ROUNDS = 50;
export const MAX_ENCODED_CHARS = 60_000;

const MARKER_PREFIX = `<!-- factory:run-state ${PR_RUN_STATE_VERSION} key:`;
const MARKER_RE = new RegExp(`<!-- factory:run-state ${PR_RUN_STATE_VERSION} key:(\\S+) -->`);
const DATA_RE = /<!-- factory:run-state-data ([A-Za-z0-9+/=]*) sha256:([0-9a-f]{64}) -->/;
const PAGE_SIZE = 100;

export function prRunStateMarker(key: WorkKey): string {
  return `${MARKER_PREFIX}${key} -->`;
}

export interface PrRunRound {
  kind: 'check' | 'review' | 'ci';
  id?: number;
  headSha: string;
  at: string;
}

export interface PrRunState {
  version: 1;
  key: WorkKey;
  prNumber: number;
  status: PrRunStatus;
  draftReason?: (typeof PR_DRAFT_REASONS)[number];
  spec: { sha256: string; summary: string };
  checkRework: { used: number; cap: number };
  reviewRework: { used: number; cap: number };
  handledReviewIds: number[];
  handledCommentIds: number[];
  rounds: PrRunRound[];
  updatedAt: string;
}

export type PrRunStateRejectReason =
  'untrusted-author' | 'digest-mismatch' | 'key-mismatch' | 'malformed' | 'identity-unavailable';

export interface PrStateComment {
  id: number;
  authorId: number | undefined;
  authorLogin?: string;
  authorType?: string;
  body: string;
}

type Ignored = { commentId: number; reason: PrRunStateRejectReason }[];
export type PrRunStateLoad =
  { status: 'found'; commentId: number; state: PrRunState; ignored: Ignored } | { status: 'none'; ignored: Ignored };

const count = z.number().int().nonnegative();
const sha = z.string().regex(/^[0-9a-f]{7,40}$/);
const counter = z.object({ used: count, cap: count }).strict();
const schema = z
  .object({
    version: z.literal(1),
    key: z.string().min(1),
    prNumber: count,
    status: z.enum(PR_RUN_STATUSES),
    draftReason: z.enum(PR_DRAFT_REASONS).optional(),
    spec: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$|^$/), summary: z.string() }).strict(),
    checkRework: counter,
    reviewRework: counter,
    handledReviewIds: z.array(count),
    handledCommentIds: z.array(count),
    rounds: z.array(
      z
        .object({ kind: z.enum(['check', 'review', 'ci']), id: count.optional(), headSha: sha, at: z.string() })
        .strict(),
    ),
    updatedAt: z.string(),
  })
  .strict();

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const clampCount = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
const uniqueSorted = (ids: readonly number[]): number[] => [...new Set(ids.map(clampCount))].sort((a, b) => a - b);

/** Allow-list step: rebuilds the state from known fields only, redacts the summary and bounds every list. */
export function sanitizePrRunState(state: PrRunState, maxIds = MAX_HANDLED_IDS, maxRounds = MAX_ROUNDS): PrRunState {
  return {
    version: 1,
    key: state.key,
    prNumber: clampCount(state.prNumber),
    status: state.status,
    ...(state.draftReason ? { draftReason: state.draftReason } : {}),
    spec: { sha256: state.spec.sha256, summary: redactSecrets(state.spec.summary).slice(0, SPEC_SUMMARY_MAX) },
    checkRework: { used: clampCount(state.checkRework.used), cap: clampCount(state.checkRework.cap) },
    reviewRework: { used: clampCount(state.reviewRework.used), cap: clampCount(state.reviewRework.cap) },
    handledReviewIds: uniqueSorted(state.handledReviewIds).slice(-maxIds),
    handledCommentIds: uniqueSorted(state.handledCommentIds).slice(-maxIds),
    rounds: state.rounds.slice(-maxRounds).map((r) => ({
      kind: r.kind,
      ...(r.id === undefined ? {} : { id: clampCount(r.id) }),
      headSha: r.headSha,
      at: r.at,
    })),
    updatedAt: state.updatedAt,
  };
}

function render(state: PrRunState): string {
  const json = JSON.stringify(state);
  return [
    prRunStateMarker(state.key),
    '_Factory run state for resuming on another host. Do not edit; edits are ignored._',
    `<!-- factory:run-state-data ${Buffer.from(json).toString('base64')} sha256:${sha256(json)} -->`,
  ].join('\n');
}

/** The hidden marker block for a state; halves rounds and handled ids until it fits one comment. */
export function encodePrRunState(state: PrRunState): string {
  let ids = MAX_HANDLED_IDS;
  let rounds = MAX_ROUNDS;
  let body = render(sanitizePrRunState(state, ids, rounds));
  while (body.length > MAX_ENCODED_CHARS && (ids > 0 || rounds > 0)) {
    ids = Math.floor(ids / 2);
    rounds = Math.floor(rounds / 2);
    body = render(sanitizePrRunState(state, ids, rounds));
  }
  return body;
}

export function decodePrRunState(
  body: string,
  key: WorkKey,
): { ok: true; state: PrRunState } | { ok: false; reason: PrRunStateRejectReason } | null {
  const marker = MARKER_RE.exec(body);
  if (!marker) return null;
  if (marker[1] !== key) return { ok: false, reason: 'key-mismatch' };
  const data = DATA_RE.exec(body);
  if (!data) return { ok: false, reason: 'malformed' };
  const json = Buffer.from(data[1] ?? '', 'base64').toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const checked = schema.safeParse(parsed);
  if (!checked.success) return { ok: false, reason: 'malformed' };
  if (sha256(json) !== data[2]) return { ok: false, reason: 'digest-mismatch' };
  if (checked.data.key !== key) return { ok: false, reason: 'key-mismatch' };
  return { ok: true, state: { ...checked.data, key } };
}

/**
 * Picks the state to trust: only a comment by `self` (the authenticated identity) is decoded. Lowest comment id
 * wins, as in `readParkState`. An unknown identity fails closed: every marker comment is ignored.
 */
export function selectTrustedPrRunState(
  comments: readonly PrStateComment[],
  self: SelfIdentity | undefined,
  key: WorkKey,
): PrRunStateLoad {
  const ignored: Ignored = [];
  let winner: { commentId: number; state: PrRunState } | undefined;
  for (const c of [...comments].sort((a, b) => a.id - b.id)) {
    if (!MARKER_RE.test(c.body)) continue;
    if (self === undefined) {
      ignored.push({ commentId: c.id, reason: 'identity-unavailable' });
      continue;
    }
    if (!isOwnComment({ id: c.authorId, login: c.authorLogin, type: c.authorType }, self)) {
      ignored.push({ commentId: c.id, reason: 'untrusted-author' });
      continue;
    }
    const decoded = decodePrRunState(c.body, key);
    if (decoded === null) continue;
    if (!decoded.ok) ignored.push({ commentId: c.id, reason: decoded.reason });
    else winner ??= { commentId: c.id, state: decoded.state };
  }
  return winner ? { status: 'found', ...winner, ignored } : { status: 'none', ignored };
}

function mergeRounds(a: readonly PrRunRound[], b: readonly PrRunRound[]): PrRunRound[] {
  const seen = new Map<string, PrRunRound>();
  for (const r of [...a, ...b]) seen.set(`${r.kind}:${r.id ?? ''}:${r.headSha}`, r);
  return [...seen.values()].sort((x, y) => x.at.localeCompare(y.at));
}

/**
 * Monotonic merge of local and remote state. `used` counters take the max (a restore can only raise them, never
 * reset a cap), `cap` comes from local because local config is current, handled ids and rounds are unioned (rounds
 * deduped by kind+id+headSha, sorted by `at`), and `status`, `spec` and `prNumber` come from the side with the
 * later `updatedAt`. One missing side returns the other.
 */
export function reconcilePrRunState(local: PrRunState | null, remote: PrRunState | null): PrRunState | null {
  if (local === null) return remote;
  if (remote === null) return local;
  const later = remote.updatedAt > local.updatedAt ? remote : local;
  return {
    version: 1,
    key: local.key,
    prNumber: later.prNumber,
    status: later.status,
    ...(later.draftReason ? { draftReason: later.draftReason } : {}),
    spec: later.spec,
    checkRework: { used: Math.max(local.checkRework.used, remote.checkRework.used), cap: local.checkRework.cap },
    reviewRework: { used: Math.max(local.reviewRework.used, remote.reviewRework.used), cap: local.reviewRework.cap },
    handledReviewIds: uniqueSorted([...local.handledReviewIds, ...remote.handledReviewIds]),
    handledCommentIds: uniqueSorted([...local.handledCommentIds, ...remote.handledCommentIds]),
    rounds: mergeRounds(local.rounds, remote.rounds),
    updatedAt: local.updatedAt > remote.updatedAt ? local.updatedAt : remote.updatedAt,
  };
}

export function prRunStatusFor(status: RunStatus, ciPending?: boolean): PrRunStatus {
  switch (status) {
    case 'pending':
    case 'planning':
    case 'building':
    case 'checking':
    case 'reworking':
      return 'building';
    case 'shipping':
      return 'awaiting-ci';
    case 'ready':
      return ciPending ? 'awaiting-ci' : 'awaiting-review';
    case 'awaiting-review':
    case 'merged':
      return 'awaiting-review';
    case 'parked':
    case 'escalated':
    case 'failed':
      return 'parked';
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

export async function loadPrRunState(deps: {
  octokit: SelfIdentityOctokit;
  repo: string;
  prNumber: number;
  key: WorkKey;
}): Promise<PrRunStateLoad> {
  const { octokit, repo, prNumber, key } = deps;
  const [owner, name] = repo.split('/');
  let self: SelfIdentity | undefined;
  try {
    self = await resolveSelfIdentity(octokit);
  } catch {
    self = undefined;
  }
  const comments: PrStateComment[] = [];
  for (let page = 1; ; page++) {
    const { data } = await octokit.rest.issues.listComments({
      owner,
      repo: name,
      issue_number: prNumber,
      per_page: PAGE_SIZE,
      page,
    });
    for (const c of data) {
      comments.push({
        id: c.id,
        authorId: c.user?.id,
        authorLogin: c.user?.login,
        authorType: c.user?.type,
        body: c.body ?? '',
      });
    }
    if (data.length < PAGE_SIZE) break;
  }
  return selectTrustedPrRunState(comments, self, key);
}

export function savePrRunState(deps: {
  octokit: Octokit;
  repo: string;
  prNumber: number;
  state: PrRunState;
}): Promise<{ commentId: number; created: boolean }> {
  const { octokit, repo, prNumber, state } = deps;
  return upsertMarkerComment({
    octokit,
    repo,
    issue: workKeyFromIssue(prNumber),
    marker: prRunStateMarker(state.key),
    body: encodePrRunState(state),
  });
}
