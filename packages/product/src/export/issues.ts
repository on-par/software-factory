// packages/product/src/export/issues.ts — Epic/Story -> GitHub issue payloads (#476).

import type { AcceptanceCriterion, Epic, Story } from '@on-par/contracts';

export interface IssuePayload {
  title: string;
  body: string;
  labels: readonly string[];
}

function joinList(items: readonly string[] | undefined): string {
  return (items ?? []).join(', ');
}

function gherkinBlock(criterion: AcceptanceCriterion): string[] {
  const lines: string[] = ['```gherkin', `Scenario: ${criterion.name}`];

  if (criterion.given.length > 0) {
    lines.push(`  Given ${criterion.given[0]}`);
    for (const given of criterion.given.slice(1)) {
      lines.push(`  And ${given}`);
    }
  }

  lines.push(`  When ${criterion.when[0]}`);
  for (const when of criterion.when.slice(1)) {
    lines.push(`  And ${when}`);
  }

  lines.push(`  Then ${criterion.then[0]}`);
  for (const then of criterion.then.slice(1)) {
    lines.push(`  And ${then}`);
  }

  lines.push('```');

  if (criterion.tracesTo.length > 0) {
    lines.push(`Traces to: ${joinList(criterion.tracesTo)}`);
  }

  return lines;
}

/** Renders an Epic as the epic-level GitHub issue payload. */
export function renderEpicIssue(epic: Epic): IssuePayload {
  const lines: string[] = ['## Why', epic.why, '', '## Done when'];

  for (const item of epic.doneWhen) {
    lines.push(`- [ ] ${item}`);
  }

  lines.push('', '## Stories (build order)');
  for (const child of epic.children) {
    lines.push(`- ${child}`);
  }

  if (epic.whatAlreadyExists !== undefined) {
    lines.push('', '## What already exists', epic.whatAlreadyExists);
  }

  if (epic.tracesTo.length > 0) {
    lines.push('', `Traces to: ${joinList(epic.tracesTo)}`);
  }

  return { title: epic.title, body: lines.join('\n'), labels: epic.labels };
}

/** Renders a Story as a GitHub issue payload, optionally linked to a filed epic number. */
export function renderStoryIssue(story: Story, epicNumber?: number): IssuePayload {
  const lines: string[] = [];

  if (epicNumber !== undefined) {
    lines.push(`Part of #${epicNumber}`, '');
  }

  lines.push(
    `As a ${story.role}, I want ${story.want}, so that ${story.soThat}`,
    '',
    '## Problem',
    story.problemStatement,
  );

  lines.push('', '## In scope');
  for (const item of story.inScope) {
    lines.push(`- ${item}`);
  }

  if (story.outOfScope.length > 0) {
    lines.push('', '## Out of scope');
    for (const item of story.outOfScope) {
      lines.push(`- ${item}`);
    }
  }

  lines.push('', '## Acceptance criteria');
  for (const criterion of story.acceptanceCriteria) {
    lines.push(...gherkinBlock(criterion), '');
  }
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }

  lines.push('', '## Verification');
  for (const step of story.verification) {
    lines.push(`- ${step.command} — passes when: ${step.passWhen}`);
  }

  if (story.investNote !== undefined) {
    lines.push('', `INVEST: ${story.investNote}`);
  }

  if (story.tracesTo.length > 0) {
    lines.push('', `Traces to: ${joinList(story.tracesTo)}`);
  }

  return { title: story.title, body: lines.join('\n'), labels: story.labels };
}
