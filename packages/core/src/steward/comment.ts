// src/steward/comment.ts — render a steward verdict as a fenced markdown issue comment with a hidden marker (#2118, ADR-0144, ADR-0130)
import { createHash } from 'node:crypto';
import { fenceExcerpt, stripHiddenContent } from '../filing/sanitize.js';
import type { StuckTrigger } from './detect.js';
import type { StewardVerdict } from './diagnose.js';

/** Version tag in the hidden steward marker. */
export const STEWARD_COMMENT_MARKER_VERSION = 'v1';

export interface StewardCommentInput {
  /** An EscalatedStewardVerdict is assignable; `escalate` is ignored here. */
  verdict: StewardVerdict;
  trigger: StuckTrigger;
  runId: string;
  /** The run's failure signature; only its hash reaches the marker. */
  signature: string;
  /** Optional `host:path` pointer to the run directory (ADR-0131 style). */
  runPointer?: string;
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
  const sig = createHash('sha256').update(signature).digest('hex').slice(0, 16);
  return `<!-- factory-steward ${STEWARD_COMMENT_MARKER_VERSION} run:${safeRunId(runId)} signature:${sig} -->`;
}

function fenced(text: string): string {
  return fenceExcerpt(stripHiddenContent(text));
}

/** Render a steward verdict as a markdown comment body; all model text sits inside an unbreakable fence. */
export function renderStewardComment(input: StewardCommentInput): string {
  const { verdict, trigger, runId, signature, runPointer } = input;
  const lines: string[] = [
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
    '**Recommended next step**',
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
