// packages/product/src/architecture/render.ts — ADR-conformance report renderer (#477).
import { renderEpicArchitecture } from '../export/index.js';
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
