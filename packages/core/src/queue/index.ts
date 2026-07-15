// packages/core/src/queue/index.ts — Proposed-queue validation for `factory triage accept`.

export interface QueueValidationResult {
  ok: boolean;
  /** Issue numbers parsed from entry lines, in queue order (best-effort even when !ok). */
  issues: number[];
  /** Human-readable problems, each prefixed with the 1-based line number. */
  errors: string[];
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

    const match = /^(\S+)\s+(\d+)\s*$/.exec(line);
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
