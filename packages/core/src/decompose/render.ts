// src/decompose/render.ts — renders a validated ProposedDecomposition as a single,
// copy-pasteable GitHub comment. Pure string building — no I/O, no clock (#606).

import type { Story } from '@on-par/contracts';

import type { ProposedDecomposition } from './parse.js';

export const DECOMPOSITION_MARKER = '<!-- factory:decomposition -->';

function renderCriterion(criterion: Story['acceptanceCriteria'][number]): string {
  const given = criterion.given.length > 0 ? `Given ${criterion.given.join(', ')}, ` : '';
  return `- [ ] ${criterion.name} — ${given}When ${criterion.when.join(', ')}, Then ${criterion.then.join(', ')}`;
}

function renderStory(story: Story, index: number): string[] {
  const lines = [
    `### Story ${index + 1} — ${story.title}`,
    '',
    `**Why:** ${story.soThat}`,
    `**Goal:** As a ${story.role}, I want ${story.want}`,
    '',
  ];
  lines.push('```markdown');
  lines.push('### Problem statement');
  lines.push('');
  lines.push(story.problemStatement);
  lines.push('');
  lines.push('### In scope');
  lines.push('');
  for (const item of story.inScope) lines.push(`- ${item}`);
  lines.push('');
  lines.push('### Out of scope');
  lines.push('');
  for (const item of story.outOfScope) lines.push(`- ${item}`);
  lines.push('');
  lines.push('### Acceptance criteria');
  lines.push('');
  for (const criterion of story.acceptanceCriteria) lines.push(renderCriterion(criterion));
  lines.push('');
  lines.push('### Verification');
  lines.push('');
  for (const step of story.verification) lines.push(`- \`${step.command}\` — ${step.passWhen}`);
  lines.push('```');
  return lines;
}

export function renderDecompositionComment(input: {
  issue: number;
  sizeReason: string;
  decomposition: ProposedDecomposition;
}): string {
  const { issue, sizeReason, decomposition } = input;
  const { epic, stories } = decomposition;

  const lines: string[] = [
    DECOMPOSITION_MARKER,
    '## Proposed decomposition',
    '',
    `Issue #${issue} is oversized (\`${sizeReason}\`). Below is a proposed epic and ${stories.length} INVEST-sized stories. ` +
      'Nothing has been filed and this issue has not been modified — a human decides whether to file.',
    '',
    `### Epic — [EPIC] ${epic.title}`,
    '',
    '```markdown',
    '### Why',
    '',
    epic.why,
    '',
    '### Children',
    '',
    ...epic.children.map((title, i) => `- [ ] ${i + 1}. ${title}`),
    '',
    '### Done when',
    '',
    ...epic.doneWhen.map((item) => `- ${item}`),
    '```',
    '',
    '### Sequencing',
    '',
    ...stories.map((story, i) => `${i + 1}. ${story.title} — ${story.soThat}`),
    '',
  ];

  stories.forEach((story, i) => {
    lines.push(...renderStory(story, i));
    lines.push('');
  });

  return lines.join('\n').trimEnd();
}
