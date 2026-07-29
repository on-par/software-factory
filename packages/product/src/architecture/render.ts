// packages/product/src/architecture/render.ts — ADR-conformance + design-critic report renderers (#477, #478).
import { renderEpicArchitecture } from '../export/index.js';
import type { EpicDesignCritique } from './critic.js';
import type { EpicArchitecture } from './design.js';

export function renderArchitectureReport(architecture: EpicArchitecture): string[] {
  const lines: string[] = [...renderEpicArchitecture(architecture.artifact), '', '## ADR conformance'];

  for (const constraint of architecture.constraints) {
    lines.push(`- [${constraint.adr ?? 'needs new ADR'}] ${constraint.text}`);
  }

  lines.push('', '## Deviations (need a new ADR)');
  if (architecture.deviations.length === 0) {
    lines.push('None.');
  } else {
    for (const deviation of architecture.deviations) {
      lines.push(`- ${deviation.text}`);
    }
  }

  return lines;
}

function criticStopReasonLine(critique: EpicDesignCritique): string {
  if (critique.stopReason === 'passed') {
    return 'Stop reason: passed';
  }
  return `Stop reason: ${critique.stopReason} after ${critique.iterations} rework iteration(s)`;
}

/** Human-readable markdown lines for the CLI. Matches renderJudgeReport's style. */
export function renderCriticReport(critique: EpicDesignCritique): string[] {
  const { verdict, scoreHistory } = critique;

  const lines: string[] = [
    '# Epic-Design Critique',
    `Verdict: ${verdict.verdict} — ${verdict.score}/100`,
    criticStopReasonLine(critique),
    `Score history: ${scoreHistory.join(' → ')}`,
    verdict.violatedAdrs.length > 0 ? `Violated ADRs: ${verdict.violatedAdrs.join(', ')}` : 'Violated ADRs: none',
    `Rationale: ${verdict.rationale}`,
  ];

  const failedChecks = verdict.checks.filter((c) => !c.passed);
  if (failedChecks.length > 0) {
    lines.push('Failed checks:');
    for (const check of failedChecks) {
      lines.push(`- ${check.id}: ${check.note}`);
    }
  }

  return lines;
}
