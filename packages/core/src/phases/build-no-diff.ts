// src/phases/build-no-diff.ts — no-diff BUILD cause and worker output tail (#3273)
import { redactText } from '../filing/redact.js';

export type NoDiffCause = 'sandbox' | 'open-questions' | 'unknown';

const SANDBOX_PATTERN = /Operation not permitted|sandbox_apply|sandbox denied|\bEPERM\b|\bEACCES\b/i;
const TAIL_LINES = 20;
const TAIL_MAX_CHARS = 2000;
const MAX_QUESTIONS = 3;

function stripAnsi(text: string): string {
  return text
    .split(String.fromCharCode(27))
    .map((part, index) => (index === 0 ? part : part.replace(/^\[[0-9;?]*[A-Za-z]|^[()][A-Za-z0-9]/, '')))
    .join('');
}

export function classifyNoDiff(input: { output: string; openQuestions?: readonly string[] }): NoDiffCause {
  if (SANDBOX_PATTERN.test(stripAnsi(input.output))) return 'sandbox';
  if ((input.openQuestions?.length ?? 0) > 0) return 'open-questions';
  return 'unknown';
}

export function workerOutputTail(output: string, opts: { lines?: number; maxChars?: number } = {}): string {
  const { lines = TAIL_LINES, maxChars = TAIL_MAX_CHARS } = opts;
  const kept = stripAnsi(output)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(-lines);
  if (kept.length === 0) return '';
  // Redact before truncating so a cut cannot leave a partial token the patterns miss.
  const redacted = redactText(kept.join('\n'));
  return redacted.length > maxChars ? redacted.slice(-maxChars) : redacted;
}

export function renderNoDiffDetail(input: {
  cause?: NoDiffCause;
  tail: string;
  openQuestions?: readonly string[];
}): string {
  const lines: string[] = [];
  if (input.cause) lines.push(`cause: ${input.cause}`);
  if (input.cause === 'open-questions') {
    const questions = (input.openQuestions ?? []).map((q) => q.trim()).filter((q) => q !== '');
    lines.push('plan open questions (update the issue body before requeue):');
    for (const q of questions.slice(0, MAX_QUESTIONS)) lines.push(`- ${q}`);
    if (questions.length > MAX_QUESTIONS) lines.push(`- …and ${questions.length - MAX_QUESTIONS} more`);
  }
  if (input.tail === '') {
    lines.push('worker output was empty');
  } else {
    lines.push(`worker output (last ${TAIL_LINES} non-blank lines):`, input.tail);
  }
  return lines.join('\n');
}
