// packages/core/src/readiness/decompose-coverage.ts — parent-criterion coverage for the size gate (#3105).
//
// A parent issue's checkbox acceptance criteria get stable ids (P1, P2, ...); child criteria trace to
// them, and a decomposition that leaves one untraced is rejected. checkParentCriteriaCoverage is a port
// of product's checkTraceability (packages/product/src/intent/trace.ts) — keep the two in step.

import { formatParentCriterionId, isParentCriterionId } from '@on-par/contracts';
import type { Story } from '@on-par/contracts';

import { assessAcceptanceCriteria } from './criteria.js';
import type { ParentCriterion } from './decompose-prompt.js';
import { extractIssueSections, findSection } from './index.js';

/** Ids are the checkbox's 1-based position, so skipping an empty box keeps the rest stable. */
export function parseParentCriteria(body: string): ParentCriterion[] {
  const section = findSection(extractIssueSections(body ?? ''), 'Acceptance criteria');
  return assessAcceptanceCriteria(section ?? '')
    .filter((finding) => finding.grade !== 'empty')
    .map((finding) => ({ id: formatParentCriterionId(finding.index), text: finding.text }));
}

/** Every distinct parent-criterion id the story's criteria trace to, in numeric order. */
export function parentIdsTracedBy(story: Story): string[] {
  const ids = new Set<string>();
  for (const criterion of story.acceptanceCriteria) {
    for (const id of criterion.tracesTo) if (isParentCriterionId(id)) ids.add(id);
  }
  return [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

export function checkParentCriteriaCoverage(
  parentCriteria: readonly ParentCriterion[],
  stories: readonly Story[],
): { ok: boolean; uncovered: ParentCriterion[]; unknownIds: string[] } {
  const referenced = new Set<string>();
  for (const story of stories) for (const id of parentIdsTracedBy(story)) referenced.add(id);
  const known = new Set(parentCriteria.map((criterion) => criterion.id));
  const uncovered = parentCriteria.filter((criterion) => !referenced.has(criterion.id));
  const unknownIds = [...referenced].filter((id) => !known.has(id));
  return { ok: uncovered.length === 0 && unknownIds.length === 0, uncovered, unknownIds };
}
