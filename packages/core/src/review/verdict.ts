// packages/core/src/review/verdict.ts — pure three-tier review verdict with reasons (#1679).

import type { CheckSummary } from '../types/index.js';

export type ReviewVerdict = 'approve' | 'approve with comments' | 'request changes';

export type ReviewContextLevel = 'rich' | 'thin';

/** One acceptance-criteria reviewer finding. `unmet` blocks; `advisory` is a non-blocking note. */
export interface AcceptanceCriterionFinding {
  criterion: string;
  status: 'met' | 'unmet' | 'advisory';
  /** Optional explanation from the reviewer, appended to the reason. */
  detail?: string;
}

export interface ReviewVerdictInput {
  summary: CheckSummary;
  criteria: readonly AcceptanceCriterionFinding[];
  context: ReviewContextLevel;
  /** Checker names the constitution requires (Constitution.checkers). A SKIP of one caps the verdict. */
  requiredCheckers: readonly string[];
}

export interface ReviewVerdictResult {
  verdict: ReviewVerdict;
  /** The reasons from the tier that decided the verdict; [] for approve. */
  reasons: string[];
}

/** Checkers whose FAIL is reproducible and therefore blocks the review. */
export const DETERMINISTIC_CHECKERS: readonly string[] = ['compile', 'tests', 'lint', 'links', 'accessibility'];

function withDetail(text: string, detail: string | undefined): string {
  const trimmed = detail?.trim();
  return trimmed ? `${text}: ${trimmed}` : text;
}

export function computeReviewVerdict(input: ReviewVerdictInput): ReviewVerdictResult {
  const { summary, criteria, context, requiredCheckers } = input;

  const blocking: string[] = [];
  for (const r of summary.results) {
    if (r.result === 'FAIL' && DETERMINISTIC_CHECKERS.includes(r.checker)) {
      blocking.push(withDetail(`checker ${r.checker} failed`, r.details));
    }
  }
  for (const c of criteria) {
    if (c.status === 'unmet') {
      blocking.push(withDetail(`acceptance criterion unmet: ${c.criterion}`, c.detail));
    }
  }
  if (blocking.length > 0) {
    return { verdict: 'request changes', reasons: blocking };
  }

  const comments: string[] = [];
  for (const r of summary.results) {
    if (r.result === 'FAIL' && !DETERMINISTIC_CHECKERS.includes(r.checker)) {
      comments.push(withDetail(`advisory: checker ${r.checker} failed`, r.details));
    }
  }
  for (const r of summary.results) {
    if (r.result === 'SKIP' && requiredCheckers.includes(r.checker)) {
      comments.push(withDetail(`required checker ${r.checker} was skipped`, r.details));
    }
  }
  for (const c of criteria) {
    if (c.status === 'advisory') {
      comments.push(withDetail(`advisory: ${c.criterion}`, c.detail));
    }
  }
  if (context === 'thin') {
    comments.push('context was thin: the verdict is capped at approve with comments');
  }
  if (comments.length > 0) {
    return { verdict: 'approve with comments', reasons: comments };
  }

  return { verdict: 'approve', reasons: [] };
}
