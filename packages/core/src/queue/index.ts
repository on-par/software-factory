// packages/core/src/queue/index.ts — Proposed-queue validation for `factory triage accept`.

import { existsSync, readFileSync } from 'node:fs';

const ENTRY_RE = /^(\S+)\s+(\d+)\s*$/;

export interface QueueValidationResult {
  ok: boolean;
  /** Issue numbers parsed from entry lines, in queue order (best-effort even when !ok). */
  issues: number[];
  /** Human-readable problems, each prefixed with the 1-based line number. */
  errors: string[];
}

export interface QueueEntry {
  lane: string;
  issue: number;
  /** 1-based line number in the queue file. */
  lineNo: number;
}

export interface QueueDiagnostic {
  lineNo: number;
  /** The offending line, trimmed. */
  raw: string;
  message: string;
}

export interface ParsedQueue {
  entries: QueueEntry[];
  diagnostics: QueueDiagnostic[];
}

/** Pure, validated queue-line parser for run-time consumption (status/run/supervise). */
export function parseQueue(content: string): ParsedQueue {
  const lines = content.split('\n');
  const entries: QueueEntry[] = [];
  const diagnostics: QueueDiagnostic[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const trimmed = lines[i].trim();

    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const match = ENTRY_RE.exec(trimmed);
    const issue = match ? parseInt(match[2], 10) : NaN;
    if (!match || issue < 1) {
      diagnostics.push({
        lineNo,
        raw: trimmed,
        message: `line ${lineNo}: malformed entry "${trimmed}" — expected "<lane> <issue#>"`,
      });
      continue;
    }

    entries.push({ lane: match[1], issue, lineNo });
  }

  return { entries, diagnostics };
}

/**
 * Replaces the queue entry for a decomposed issue with one entry per child issue, on
 * the same lane as the entry it replaces. Pure and line-preserving: every other entry,
 * comment, and blank line is left byte-identical. Children already queued elsewhere are
 * not duplicated, and any further (malformed-duplicate) entry line for `opts.issue` is
 * dropped — the decomposed parent must not survive in the queue.
 */
export function rewriteQueueForDecomposition(
  content: string,
  opts: { issue: number; childIssues: readonly number[] },
): { content: string; changed: boolean } {
  const { issue, childIssues } = opts;
  if (childIssues.length === 0) return { content, changed: false };

  const lines = content.split('\n');
  const queuedIssues = new Set(parseQueue(content).entries.map((entry) => entry.issue));

  let replaced = false;
  const result: string[] = [];

  for (const line of lines) {
    const match = ENTRY_RE.exec(line.trim());
    const lineIssue = match ? parseInt(match[2], 10) : NaN;

    if (match && lineIssue === issue) {
      if (!replaced) {
        const lane = match[1];
        for (const child of childIssues) {
          if (queuedIssues.has(child)) continue;
          result.push(`${lane} ${child}`);
          queuedIssues.add(child);
        }
        replaced = true;
      }
      continue; // drop this line (the original entry, or a malformed duplicate of it)
    }

    result.push(line);
  }

  if (!replaced) return { content, changed: false };

  return { content: result.join('\n'), changed: true };
}

export function validateQueue(content: string): QueueValidationResult {
  const lines = content.split('\n');

  let lastNonBlankIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') lastNonBlankIndex = i;
  }

  const issues: number[] = [];
  const errors: string[] = [];
  const seenIssues = new Set<number>();

  for (let i = 0; i <= lastNonBlankIndex; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const trimmed = line.trim();

    if (trimmed === '') {
      errors.push(`line ${lineNo}: empty line in the middle of the queue`);
      continue;
    }

    if (trimmed.startsWith('#')) continue;

    const match = ENTRY_RE.exec(line);
    const issueNum = match ? parseInt(match[2], 10) : NaN;
    if (!match || issueNum === 0) {
      errors.push(`line ${lineNo}: malformed entry "${trimmed}" — expected "<lane> <issue#>"`);
      continue;
    }

    if (seenIssues.has(issueNum)) {
      errors.push(`line ${lineNo}: duplicate issue #${issueNum}`);
      continue;
    }

    seenIssues.add(issueNum);
    issues.push(issueNum);
  }

  if (issues.length === 0 && errors.length === 0) {
    errors.push('queue has no issue entries');
  }

  return { ok: errors.length === 0, issues, errors };
}

// ---------- Queue reading (TUI Queue tab) ----------

export interface QueueSnapshotEntry {
  lane: string;
  issue: number;
}

export interface QueueSnapshot {
  entries: QueueSnapshotEntry[];
  proposedCount?: number;
}

/** De-duplicated {lane, issue} pairs from the shared parseQueue() parser, first occurrence wins. */
function dedupedEntries(content: string): QueueSnapshotEntry[] {
  const seenIssues = new Set<number>();
  const entries: QueueSnapshotEntry[] = [];

  for (const { lane, issue } of parseQueue(content).entries) {
    if (seenIssues.has(issue)) continue;
    seenIssues.add(issue);
    entries.push({ lane, issue });
  }

  return entries;
}

/** Read the queue (and optional proposed queue) from disk. Missing file(s) → empty/undefined. */
export function readQueue(queueFile: string, queueProposedFile?: string): QueueSnapshot {
  const entries = existsSync(queueFile) ? dedupedEntries(readFileSync(queueFile, 'utf-8')) : [];

  const proposedCount =
    queueProposedFile && existsSync(queueProposedFile)
      ? parseQueue(readFileSync(queueProposedFile, 'utf-8')).entries.length
      : undefined;

  return proposedCount === undefined ? { entries } : { entries, proposedCount };
}
