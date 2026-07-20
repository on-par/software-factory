// src/failure/index.ts — Deterministic failure fingerprinting and evidence capture (#372).
// Pure, network-free utility over the existing failure object and event stream: no filing,
// no GitHub calls, no policy. See .factory/plans/issue-372.md for the full spec.

import { createHash } from 'node:crypto';

import type { CaptureFailureInput, EvidencePack, FailureSignatureInput, FingerprintedFailure } from '../types/index.js';

const DEFAULT_EXCERPT_LIMIT = 600;

/** Strip volatile tokens so the same defect normalizes identically across runs/repos. */
export function normalizeFailureMessage(message: string): string {
  return (
    (message ?? '')
      // ISO-8601 timestamps (with optional fractional seconds / tz)
      .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?/gi, '<ts>')
      // absolute / worktree / temp-dir paths (unix): /Users/.../software-factory-...-372, /tmp/..., /var/folders/...
      .replace(/(?:\/[\w.-]+)+\/?/g, '<path>')
      // issue references: "issue #123", "issue-123", "#123"
      .replace(/issue[-\s]#?\d+/gi, '<issue>')
      .replace(/#\d+/g, '<issue>')
      // PIDs: "pid 12345", "PID: 12345"
      .replace(/\bpid[:\s]+\d+/gi, '<pid>')
      // long hex blobs: sha/oid/uuid-ish
      .replace(/\b[0-9a-f-]{7,}\b/gi, '<hash>')
      // any remaining standalone number
      .replace(/\b\d+\b/g, '<n>')
      // collapse whitespace + lowercase for a canonical form
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  );
}

/** Deterministic signature over the fields that identify a defect (NOT the volatile ones). */
export function fingerprintFailure(input: FailureSignatureInput): string {
  const canonical = [
    input.phase,
    input.origin,
    input.component.trim().toLowerCase(),
    input.reason,
    normalizeFailureMessage(input.message),
  ].join(' ');
  const hex = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `ff_${hex}`;
}

/** Fingerprint + evidence pack for a terminal failure. Pure; caller supplies all context. */
export function captureFailure(input: CaptureFailureInput): FingerprintedFailure {
  const fingerprint = fingerprintFailure(input);
  const limit = input.excerptLimit ?? DEFAULT_EXCERPT_LIMIT;
  const evidence: EvidencePack = {
    repo: input.repo,
    issue: input.issue,
    phase: input.phase,
    model: input.model,
    reason: input.reason,
    component: input.component,
    origin: input.origin,
    eventExcerpt: input.message.trim().slice(0, limit),
    logPath: input.logPath,
  };
  return { fingerprint, evidence };
}
