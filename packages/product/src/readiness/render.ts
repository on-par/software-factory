// packages/product/src/readiness/render.ts — human-readable readiness report markdown (#475).

import type { ReadinessReport } from './report.js';

/** Human-readable markdown lines for the CLI. Matches renderJudgeReport's plain-ASCII style. */
export function renderReadinessReport(report: ReadinessReport): string[] {
  const lines: string[] = ['# Readiness Report', `Status: ${report.status}`, ''];

  for (const dimension of report.dimensions) {
    lines.push(`- [${dimension.ready ? 'ready' : 'not ready'}] ${dimension.label}: ${dimension.reason}`);
  }

  lines.push('', '## Open questions for the writer');
  if (report.openQuestions.length === 0) {
    lines.push('No open questions.');
  } else {
    for (const question of report.openQuestions) {
      lines.push(`- (${question.source}) ${question.text}`);
    }
  }

  return lines;
}
