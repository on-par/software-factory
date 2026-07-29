// packages/product/src/judge/render.ts — human-readable judge report markdown (#474).

import type { JudgedStory, JudgeReport } from './loop.js';

function stopReasonLine(judged: JudgedStory): string {
  if (judged.stopReason === 'passed') {
    return 'Stop reason: passed';
  }
  return `Stop reason: ${judged.stopReason} after ${judged.iterations} rework iteration(s)`;
}

/** Human-readable markdown lines for the CLI. Matches renderDecomposition's style. */
export function renderJudgeReport(report: JudgeReport): string[] {
  const lines: string[] = [
    '# Judge Report',
    `Threshold: ${report.threshold} · Max rework iterations: ${report.maxIterations}`,
  ];

  const belowThreshold = report.stories.filter((s) => s.stopReason !== 'passed');
  lines.push(
    belowThreshold.length === 0
      ? 'All stories passed.'
      : `${belowThreshold.length} of ${report.stories.length} stories below threshold.`,
  );

  report.stories.forEach((judged, i) => {
    const status = judged.stopReason === 'passed' ? 'passed' : 'below threshold';
    lines.push('', `## Story ${i + 1}: ${judged.story.title} — ${judged.verdict.score}/100 (${status})`);
    lines.push(stopReasonLine(judged));
    lines.push(`Score history: ${judged.scoreHistory.join(' → ')}`);
    lines.push(`Rationale: ${judged.verdict.rationale}`);

    const failedChecks = judged.verdict.checks.filter((c) => !c.passed);
    if (failedChecks.length > 0) {
      lines.push('Failed checks:');
      for (const check of failedChecks) {
        lines.push(`- ${check.id}: ${check.note}`);
      }
    }
  });

  return lines;
}
