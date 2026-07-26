// packages/product/src/persona/render.ts — human-readable persona panel markdown (#473).

import type { PersonaPanelReport } from './panel.js';
import { probeForPersona } from './personas.js';

function joinList(items: readonly string[]): string {
  return items.join(', ');
}

/** Human-readable markdown lines for the CLI. Matches renderDecomposition's style. */
export function renderPersonaPanel(report: PersonaPanelReport): string[] {
  const lines: string[] = ['# Persona Panel'];

  if (report.clean) {
    lines.push('No findings — every persona is satisfied.');
    return lines;
  }

  lines.push(`Findings: ${report.findings.length} from ${report.personas.join(', ')}`);

  for (const persona of report.personas) {
    const probe = probeForPersona(persona);
    lines.push('', `## ${probe.label} — ${probe.concern}`);

    for (const finding of report.findings.filter((f) => f.persona === persona)) {
      lines.push(`- [${finding.kind}] Story "${finding.subject}": ${finding.observation}`);
      if (finding.action.kind === 'question') {
        lines.push(`  Ask: ${finding.action.text}`);
      } else {
        const criterion = finding.action.criterion;
        lines.push(`  Propose criterion: ${criterion.name}`);
        if (criterion.given.length > 0) {
          lines.push(`    Given ${joinList(criterion.given)}`);
        }
        lines.push(`    When ${joinList(criterion.when)}`);
        lines.push(`    Then ${joinList(criterion.then)}`);
      }
      lines.push(`  Traces to: ${joinList(finding.tracesTo)}`);
    }
  }

  return lines;
}
