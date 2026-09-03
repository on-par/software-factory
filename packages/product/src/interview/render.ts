// packages/product/src/interview/render.ts — human-readable interview summary (#470).

import type { InterviewResult } from './interview.js';

/** Human-readable summary lines for the CLI. */
export function renderInterviewSummary(result: InterviewResult): string[] {
  const followUps = result.transcript.filter((exchange) => exchange.question.followUpDepth !== undefined).length;
  const depth = followUps > 0 ? ` plus ${followUps} follow-up(s)` : '';
  return [
    `Asked ${result.questionsAsked} of ${result.questionBudget} question(s)${depth}; stopped: ${result.stopReason}`,
    `Pinned: ${result.pinned.length > 0 ? result.pinned.join(', ') : '(none)'}`,
    `Open gaps: ${result.gaps.length > 0 ? result.gaps.join(', ') : '(none)'}`,
  ];
}
