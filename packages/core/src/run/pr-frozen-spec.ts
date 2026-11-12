// packages/core/src/run/pr-frozen-spec.ts — the frozen spec of an in-place run in a factory-owned PR comment, so a fresh clone skips PLAN (#4025)

import { createHash } from 'node:crypto';

import type { Octokit } from '@octokit/rest';
import { z } from 'zod';

import { redactSecrets } from '../filing/redact.js';
import {
  isOwnComment,
  resolveSelfIdentity,
  type SelfIdentity,
  type SelfIdentityOctokit,
} from '../utils/github-identity.js';
import { workKeyFromIssue, type WorkKey } from '../work/work-key.js';
import { upsertMarkerComment } from './park-comment.js';
import {
  listPrStateComments,
  MAX_ENCODED_CHARS,
  type PrRunStateRejectReason,
  type PrStateComment,
} from './pr-run-state.js';

export const PR_FROZEN_SPEC_VERSION = 'v1';

const MARKER_RE = new RegExp(`<!-- factory:frozen-spec ${PR_FROZEN_SPEC_VERSION} key:(\\S+) -->`);
const DATA_RE = /<!-- factory:frozen-spec-data ([A-Za-z0-9+/=]*) sha256:([0-9a-f]{64}) -->/;

export function prFrozenSpecMarker(key: WorkKey): string {
  return `<!-- factory:frozen-spec ${PR_FROZEN_SPEC_VERSION} key:${key} -->`;
}

export interface PrFrozenSpec {
  version: 1;
  key: WorkKey;
  /** issueBodyHash of the brief the spec was planned from (64-hex sha256). */
  bodyHash: string;
  /** The full spec file text. */
  spec: string;
}

type Ignored = { commentId: number; reason: PrRunStateRejectReason }[];
export type PrFrozenSpecLoad =
  { status: 'found'; commentId: number; state: PrFrozenSpec; ignored: Ignored } | { status: 'none'; ignored: Ignored };

const schema = z
  .object({
    version: z.literal(1),
    key: z.string().min(1),
    bodyHash: z.string().regex(/^[0-9a-f]{64}$/),
    spec: z.string().min(1),
  })
  .strict();

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The hidden marker block for a frozen spec, or null when it does not fit one comment. */
export function encodePrFrozenSpec(state: PrFrozenSpec): string | null {
  const json = JSON.stringify({ ...state, spec: redactSecrets(state.spec) });
  const body = [
    prFrozenSpecMarker(state.key),
    'Factory frozen plan for this run — lets an interrupted run resume without re-planning. Do not edit.',
    `<!-- factory:frozen-spec-data ${Buffer.from(json).toString('base64')} sha256:${sha256(json)} -->`,
  ].join('\n');
  return body.length > MAX_ENCODED_CHARS ? null : body;
}

export function decodePrFrozenSpec(
  body: string,
  key: WorkKey,
): { ok: true; state: PrFrozenSpec } | { ok: false; reason: PrRunStateRejectReason } | null {
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

/** Same trust rules as `selectTrustedPrRunState`: own identity only, lowest comment id wins, unknown identity fails closed. */
export function selectTrustedPrFrozenSpec(
  comments: readonly PrStateComment[],
  self: SelfIdentity | undefined,
  key: WorkKey,
): PrFrozenSpecLoad {
  const ignored: Ignored = [];
  let winner: { commentId: number; state: PrFrozenSpec } | undefined;
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
    const decoded = decodePrFrozenSpec(c.body, key);
    if (decoded === null) continue;
    if (!decoded.ok) ignored.push({ commentId: c.id, reason: decoded.reason });
    else winner ??= { commentId: c.id, state: decoded.state };
  }
  return winner ? { status: 'found', ...winner, ignored } : { status: 'none', ignored };
}

export async function loadPrFrozenSpec(deps: {
  octokit: SelfIdentityOctokit;
  repo: string;
  prNumber: number;
  key: WorkKey;
}): Promise<PrFrozenSpecLoad> {
  const { octokit, repo, prNumber, key } = deps;
  let self: SelfIdentity | undefined;
  try {
    self = await resolveSelfIdentity(octokit);
  } catch {
    self = undefined;
  }
  return selectTrustedPrFrozenSpec(await listPrStateComments(octokit, repo, prNumber), self, key);
}

/** Saves the frozen spec to the PR; null (nothing posted) when it exceeds one comment. */
export async function savePrFrozenSpec(deps: {
  octokit: Octokit;
  repo: string;
  prNumber: number;
  state: PrFrozenSpec;
}): Promise<{ commentId: number; created: boolean } | null> {
  const { octokit, repo, prNumber, state } = deps;
  const body = encodePrFrozenSpec(state);
  if (body === null) return null;
  return upsertMarkerComment({
    octokit,
    repo,
    issue: workKeyFromIssue(prNumber),
    marker: prFrozenSpecMarker(state.key),
    body,
  });
}
