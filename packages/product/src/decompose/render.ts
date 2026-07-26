// packages/product/src/decompose/render.ts — human-readable decomposition markdown (#472).

import type { Decomposition } from './decompose.js';

function joinList(items: readonly string[] | undefined): string {
  return (items ?? []).join(', ');
}

/** Human-readable markdown lines for the CLI. Matches renderIntentDoc's style. */
export function renderDecomposition(decomposition: Decomposition): string[] {
  const { epic, stories } = decomposition;
  const lines: string[] = ['# Decomposition', `## Epic: ${epic.title}`, `Why: ${epic.why}`, 'Done when:'];

  for (const item of epic.doneWhen) {
    lines.push(`- ${item}`);
  }
  lines.push(`Traces to: ${joinList(epic.tracesTo)}`);

  stories.forEach((story, i) => {
    lines.push('', `### Story ${i + 1}: ${story.title}`);
    lines.push(`As a ${story.role}, I want ${story.want}, so that ${story.soThat}`);

    lines.push('In scope:');
    for (const item of story.inScope) {
      lines.push(`- ${item}`);
    }

    lines.push('Out of scope:');
    for (const item of story.outOfScope) {
      lines.push(`- ${item}`);
    }

    lines.push('Acceptance criteria:');
    for (const criterion of story.acceptanceCriteria) {
      lines.push(`- ${criterion.name}`);
      if (criterion.given.length > 0) {
        lines.push(`  Given ${joinList(criterion.given)}`);
      }
      lines.push(`  When ${joinList(criterion.when)}`);
      lines.push(`  Then ${joinList(criterion.then)}`);
      lines.push(`  Traces to: ${joinList(criterion.tracesTo)}`);
    }

    lines.push(`Traces to: ${joinList(story.tracesTo)}`);
  });

  return lines;
}
