// packages/product/src/decompose/slices.ts — one vertical slice per scope statement (#472).

import type { IntentDoc, IntentStatement } from '../intent/index.js';
import type { IntentDimension } from '../interview/index.js';

export interface VerticalSlice {
  /** The `scope` statement this slice delivers — the slice axis. */
  scope: IntentStatement;
  /** Who it is for. Shared across every slice of one doc. */
  audience: readonly IntentStatement[];
  /** What becomes true. Shared across every slice of one doc. */
  outcome: readonly IntentStatement[];
  /** What bounds it — these become Given lines. Shared. */
  constraints: readonly IntentStatement[];
  /** What it explicitly excludes — these become outOfScope lines. Shared. */
  nonGoals: readonly IntentStatement[];
}

/** Lowercase substrings that mark layer-only (horizontal) work — not a vertical slice. */
export const HORIZONTAL_CUES: readonly string[] = [
  'refactor',
  'database table',
  'schema only',
  'backend only',
  'frontend only',
  'add a column',
  'wire up the api',
  'boilerplate',
  'plumbing',
  'stub out',
];

function statementsFor(doc: IntentDoc, dimension: IntentDimension): readonly IntentStatement[] {
  return doc.statements.filter((s) => s.dimension === dimension);
}

/** One slice per `scope` statement, in doc order; every slice shares the doc's context. */
export function planSlices(doc: IntentDoc): readonly VerticalSlice[] {
  const audience = statementsFor(doc, 'audience');
  const outcome = statementsFor(doc, 'outcome');
  const constraints = statementsFor(doc, 'constraints');
  const nonGoals = statementsFor(doc, 'nonGoals');

  return statementsFor(doc, 'scope').map((scope) => ({
    scope,
    audience,
    outcome,
    constraints,
    nonGoals,
  }));
}

/** True when a slice delivers end-to-end value rather than layer-only work. */
export function isVerticalSlice(slice: VerticalSlice): boolean {
  const text = slice.scope.text.toLowerCase();
  return slice.outcome.length > 0 && !HORIZONTAL_CUES.some((cue) => text.includes(cue));
}
