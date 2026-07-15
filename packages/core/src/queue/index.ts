// packages/core/src/queue/index.ts — Proposed-queue validation for `factory triage accept`.

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
