// packages/core/src/work/acceptance.ts — shared acceptance-criteria extraction (#507).
import { extractIssueSections, findSection } from '../readiness/index.js';
import { parseAcceptanceCriteriaSection } from '../readiness/criteria.js';

/** Acceptance-criteria lines lifted from a Markdown body; [] when there are none. */
export function extractAcceptanceCriteria(body: string): string[] {
  const section = findSection(extractIssueSections(body), 'Acceptance criteria');
  if (!section || section.trim().length === 0) return [];

  return parseAcceptanceCriteriaSection(section);
}
