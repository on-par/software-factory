// packages/product/src/architecture/render.ts — ADR-conformance + design-critic report renderers (#477, #478).
import { renderEpicArchitecture } from '../export/index.js';
import type { CritiquedDesign } from './critic.js';
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

function criticStopReasonLine(critiqued: CritiquedDesign): string {
  if (critiqued.stopReason === 'passed') {
    return 'Stop reason: passed';
  }
  return `Stop reason: ${critiqued.stopReason} after ${critiqued.iterations} rework iteration(s)`;
}

/** Human-readable markdown lines for the CLI. Matches renderJudgeReport's style. */
export function renderCriticReport(critiqued: CritiquedDesign): string[] {
  const { verdict, failedCheckHistory } = critiqued;

  const lines: string[] = [
    '# Epic-Design Critic Report',
    `Verdict: ${verdict.verdict}`,
    criticStopReasonLine(critiqued),
    `Failed-check history: ${failedCheckHistory.join(' → ')}`,
    `Rationale: ${verdict.rationale}`,
  ];

  if (verdict.violatedAdrs.length > 0) {
    lines.push(`Violated ADRs: ${verdict.violatedAdrs.join(', ')}`);
  }

  const failedChecks = verdict.checks.filter((c) => !c.passed);
  if (failedChecks.length > 0) {
    lines.push('Failed checks:');
    for (const check of failedChecks) {
      lines.push(`- ${check.id}: ${check.note}`);
    }
  }

  return lines;
}
