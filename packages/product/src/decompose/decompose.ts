// packages/product/src/decompose/decompose.ts — the intent-to-artifacts transform (#472).

import type { Epic, Story, Traceable } from '@on-par/contracts';
import { checkInvest, CONTRACTS_SCHEMA_VERSION } from '@on-par/contracts';

import type { IntentDoc } from '../intent/index.js';
import { isVerticalSlice, planSlices } from './slices.js';

export interface Decomposition {
  epic: Epic;
  stories: readonly Story[];
}

export type DecomposeResult = { ok: true; decomposition: Decomposition } | { ok: false; blockers: readonly string[] };

/** A title longer than this truncates at the last space within the limit. */
const MAX_TITLE_LENGTH = 72;

/** Trim, strip a trailing period, upper-case the first letter, and cap the length. */
function toTitle(text: string): string {
  let title = text.trim();
  if (title.endsWith('.')) {
    title = title.slice(0, -1);
  }
  if (title.length > 0) {
    title = title.charAt(0).toUpperCase() + title.slice(1);
  }
  if (title.length <= MAX_TITLE_LENGTH) {
    return title;
  }
  const truncated = title.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = truncated.lastIndexOf(' ');
  const cut = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
  return `${cut}…`;
}

/** Expand an approved intent doc into one Epic plus one INVEST story per vertical slice. */
export function decomposeIntent(doc: IntentDoc): DecomposeResult {
  const blockers: string[] = [];

  const problems = doc.statements.filter((s) => s.dimension === 'problem');
  const audience = doc.statements.filter((s) => s.dimension === 'audience');
  const outcomes = doc.statements.filter((s) => s.dimension === 'outcome');
  const scopes = doc.statements.filter((s) => s.dimension === 'scope');

  if (doc.status !== 'approved') {
    blockers.push('the decomposer needs an approved intent doc (human gate #1)');
  }
  if (problems.length === 0) {
    blockers.push('no problem statements — the epic would have no why');
  }
  if (audience.length === 0) {
    blockers.push('no audience statements — stories would have no role');
  }
  if (outcomes.length === 0) {
    blockers.push('no outcome statements — stories would have no value to trace to');
  }
  if (scopes.length === 0) {
    blockers.push('no scope statements to slice into stories');
  }

  if (blockers.length > 0) {
    return { ok: false, blockers };
  }

  const slices = planSlices(doc);
  const stories: Story[] = [];

  for (const [i, slice] of slices.entries()) {
    if (!isVerticalSlice(slice)) {
      blockers.push(`not a vertical slice: "${slice.scope.text}"`);
      continue;
    }

    const story: Story = {
      schemaVersion: CONTRACTS_SCHEMA_VERSION,
      kind: 'story',
      title: toTitle(slice.scope.text),
      role: slice.audience[0].text,
      want: slice.scope.text,
      soThat: slice.outcome[0].text,
      problemStatement: problems.map((s) => s.text).join(' '),
      inScope: [slice.scope.text],
      outOfScope: slice.nonGoals.map((s) => s.text),
      acceptanceCriteria: slice.outcome.map((o) => ({
        name: `Outcome: ${toTitle(o.text)}`,
        given: [slice.audience[0].text, ...slice.constraints.map((c) => c.text)],
        when: [slice.scope.text],
        then: [o.text],
        tracesTo: [slice.audience[0].id, ...slice.constraints.map((c) => c.id), slice.scope.id, o.id],
      })),
      verification: slice.outcome.map((o) => ({
        // No repo context in this story (#477/#479 add it), so the decomposer never
        // fabricates a command — PLAN replaces these with real ones.
        command: `manual: confirm ${o.text}`,
        passWhen: o.text,
      })),
      filesLikelyTouched: [],
      labels: [],
      investNote: `Vertical slice ${i + 1} of ${slices.length}: ${slice.scope.text}`,
      tracesTo: [slice.scope.id, ...slice.audience.map((s) => s.id), ...slice.outcome.map((s) => s.id)],
    };

    const investReport = checkInvest(story);
    if (!investReport.ok) {
      for (const violation of investReport.violations) {
        blockers.push(`story "${story.title}" fails INVEST (${violation.letter}): ${violation.reason}`);
      }
      continue;
    }

    stories.push(story);
  }

  if (blockers.length > 0) {
    return { ok: false, blockers };
  }

  const epic: Epic = {
    schemaVersion: CONTRACTS_SCHEMA_VERSION,
    kind: 'epic',
    title: toTitle(problems[0].text),
    why: problems.map((s) => s.text).join(' '),
    doneWhen: outcomes.map((s) => s.text),
    children: stories.map((s) => s.title),
    labels: [],
    // Totality invariant: stories claim every `scope` ID, the epic claims every non-scope
    // ID. Their union is every statement, so checkTraceability reports no untracedIds.
    tracesTo: doc.statements.filter((s) => s.dimension !== 'scope').map((s) => s.id),
  };

  return { ok: true, decomposition: { epic, stories } };
}

/** Everything the decomposition emits that cites intent — epic, stories, and every criterion. */
export function traceablesOf(decomposition: Decomposition): readonly Traceable[] {
  return [decomposition.epic, ...decomposition.stories, ...decomposition.stories.flatMap((s) => s.acceptanceCriteria)];
}
