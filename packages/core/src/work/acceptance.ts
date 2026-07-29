// packages/core/src/work/acceptance.ts — shared acceptance-criteria extraction (#507).
import { extractIssueSections } from '../readiness/index.js';

/** Acceptance-criteria lines lifted from a Markdown body; [] when there are none. */
export function extractAcceptanceCriteria(body: string): string[] {
  const section = extractIssueSections(body).get('acceptance criteria');
  if (!section || section.trim().length === 0) return [];

  const fenceRe = /^\s*(?:`{3,}|~{3,})/;
  const markerRe = /^\s*(?:[-*]\s*(?:\[[ xX]\]\s*)?)/;

  return section
    .split('\n')
    .filter((line) => !fenceRe.test(line))
    .map((line) => line.replace(markerRe, '').trim())
    .filter((line) => line.length > 0);
}
