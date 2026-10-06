// src/steward/comment.ts — render a steward verdict as a fenced markdown issue comment with a hidden marker (#2118, #2119), and publish it once per failure signature (#2120, ADR-0155, ADR-0130)
import { createHash } from 'node:crypto';
import { fenceExcerpt, stripHiddenContent } from '../filing/sanitize.js';
import type { StuckTrigger } from './detect.js';
import type { StewardVerdict } from './diagnose.js';

/** Version tag in the hidden steward marker. */
export const STEWARD_COMMENT_MARKER_VERSION = 'v1';

/** First line of an escalated comment (#2119, ADR-0155). */
export const STEWARD_ESCALATION_LINE = 'Escalated: steward confidence below 90%, no recommendation';

export interface StewardCommentInput {
  /** `escalate: true` (from applyEscalation) adds the escalation banner; absent or false renders the normal comment. */
  verdict: StewardVerdict & { escalate?: boolean };
  trigger: StuckTrigger;
  runId: string;
  /** The run's failure signature; only its hash reaches the marker. */
  signature: string;
  /** Optional `host:path` pointer to the run directory (ADR-0131 style). */
  runPointer?: string;
}

/** 16-hex SHA-256 prefix of a failure signature, the only form of it that reaches GitHub. */
export function stewardSignatureHash(signature: string): string {
  return createHash('sha256').update(signature).digest('hex').slice(0, 16);
}

function safeRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9_-]/g, '');
}

/**
 * Hidden dedup marker. The signature is hashed because free checker text
 * (see `failureSignature` in phases/check.ts) may contain `-->` or newlines
 * and can be very long; the runId is reduced to a safe charset.
 */
export function stewardCommentMarker(runId: string, signature: string): string {
  const sig = stewardSignatureHash(signature);
  return `<!-- factory-steward ${STEWARD_COMMENT_MARKER_VERSION} run:${safeRunId(runId)} signature:${sig} -->`;
}

function fenced(text: string): string {
  return fenceExcerpt(stripHiddenContent(text));
}

/** Render a steward verdict as a markdown comment body; all model text sits inside an unbreakable fence. */
export function renderStewardComment(input: StewardCommentInput): string {
  const { verdict, trigger, runId, signature, runPointer } = input;
  const escalated = verdict.escalate === true;
  const lines: string[] = [
    ...(escalated ? [STEWARD_ESCALATION_LINE, ''] : []),
    '### Factory steward diagnosis',
    '',
    `- **Trigger:** ${trigger}`,
    `- **Category:** ${verdict.category}`,
    `- **Confidence:** ${verdict.confidence.toFixed(2)}`,
    `- **Run:** ${safeRunId(runId)}`,
    '',
    '**Diagnosis**',
    '',
    fenced(verdict.diagnosis),
    '',
    escalated ? "**Model's suggested next step (unverified, not a recommendation)**" : '**Recommended next step**',
    '',
    fenced(verdict.nextStep),
    '',
    '**Citations**',
    '',
  ];
  verdict.citations.forEach((c, i) => {
    lines.push(`Citation ${i + 1} — \`${c.field}\``, '', fenced(c.excerpt), '');
  });
  if (runPointer !== undefined && stripHiddenContent(runPointer) !== '') {
    lines.push('**Run pointer**', '', fenced(runPointer), '');
  }
  lines.push(stewardCommentMarker(runId, signature));
  return lines.join('\n');
}

export interface StewardIssueComment {
  id: number;
  body: string;
}

/**
 * The only GitHub surface the steward publisher gets. It deliberately has no label, PR or
 * issue-edit methods, so publishing cannot change labels or comment on a PR (#2120).
 */
export interface StewardCommentGitHubClient {
  /** Every comment on the issue (implementations page through all of them). */
  listIssueComments(input: { owner: string; repo: string; issue_number: number }): Promise<StewardIssueComment[]>;
  createIssueComment(input: {
    owner: string;
    repo: string;
    issue_number: number;
    body: string;
  }): Promise<{ id: number }>;
  updateIssueComment(input: { owner: string; repo: string; comment_id: number; body: string }): Promise<void>;
}

export interface PublishStewardCommentInput extends StewardCommentInput {
  owner: string;
  repo: string;
  issue: number;
}

export interface PublishStewardCommentResult {
  action: 'created' | 'updated';
  commentId: number;
}

/** Matches the marker from `stewardCommentMarker` (STEWARD_COMMENT_MARKER_VERSION = v1) with any run id. */
const STEWARD_MARKER_PATTERN = `<!-- factory-steward ${STEWARD_COMMENT_MARKER_VERSION} run:[A-Za-z0-9_-]* signature:([0-9a-f]{16}) -->`;

/** The lowest-id comment carrying a steward marker for this failure signature, whatever its run id. */
export function findStewardComment(
  comments: readonly StewardIssueComment[],
  signature: string,
): StewardIssueComment | undefined {
  const want = stewardSignatureHash(signature);
  let found: StewardIssueComment | undefined;
  for (const comment of comments) {
    if (found !== undefined && comment.id >= found.id) continue;
    const re = new RegExp(STEWARD_MARKER_PATTERN, 'g');
    if ([...comment.body.matchAll(re)].some((m) => m[1] === want)) found = comment;
  }
  return found;
}

/** Upsert the rendered steward comment on the issue: edit the same-signature comment in place, else create one. */
export async function publishStewardComment(
  client: StewardCommentGitHubClient,
  input: PublishStewardCommentInput,
): Promise<PublishStewardCommentResult> {
  const { owner, repo, issue, ...render } = input;
  const body = renderStewardComment(render);
  const comments = await client.listIssueComments({ owner, repo, issue_number: issue });
  const existing = findStewardComment(comments, render.signature);
  if (existing) {
    await client.updateIssueComment({ owner, repo, comment_id: existing.id, body });
    return { action: 'updated', commentId: existing.id };
  }
  const { id } = await client.createIssueComment({ owner, repo, issue_number: issue, body });
  return { action: 'created', commentId: id };
}
