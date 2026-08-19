// packages/product/src/decompose/slices.ts — one vertical slice per scope statement (#472).

import type { IntentStatementId } from '@on-par/contracts';

import type { IntentDoc, IntentStatement } from '../intent/index.js';
import type { IntentDimension } from '../interview/index.js';
import { buildStoryMap, stagesMatching, type BackboneStep } from './story-map.js';

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
  /** The backbone step this slice's scope statement sits on. */
  step: BackboneStep;
  /** 1-based release along the backbone. Release 1 is the walking skeleton. */
  release: number;
  /** Exactly one slice per doc is the walking skeleton — the thinnest end-to-end path. */
  walkingSkeleton: boolean;
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

interface SliceCandidate {
  scope: IntentStatement;
  docIndex: number;
  step: BackboneStep;
  span: number;
  words: number;
}

/** Total comparator: most stages spanned, then earliest step, then fewest words, then doc order. */
function compareForSkeleton(a: SliceCandidate, b: SliceCandidate): number {
  if (a.span !== b.span) {
    return b.span - a.span;
  }
  if (a.step.rank !== b.step.rank) {
    return a.step.rank - b.step.rank;
  }
  if (a.words !== b.words) {
    return a.words - b.words;
  }
  return a.docIndex - b.docIndex;
}

/**
 * One slice per `scope` statement, ordered along the doc's story-map backbone: the walking
 * skeleton first (release 1), then the remaining slices grouped into releases by backbone step.
 */
export function planSlices(doc: IntentDoc): readonly VerticalSlice[] {
  const audience = statementsFor(doc, 'audience');
  const outcome = statementsFor(doc, 'outcome');
  const constraints = statementsFor(doc, 'constraints');
  const nonGoals = statementsFor(doc, 'nonGoals');

  const { backbone } = buildStoryMap(doc);
  const stepOf = new Map<IntentStatementId, BackboneStep>();
  for (const step of backbone) {
    for (const scopeId of step.scopeIds) {
      stepOf.set(scopeId, step);
    }
  }

  const candidates: SliceCandidate[] = statementsFor(doc, 'scope').map((scope, docIndex) => ({
    scope,
    docIndex,
    step: stepOf.get(scope.id)!,
    span: stagesMatching(scope.text).length,
    words: scope.text.trim().split(/\s+/).length,
  }));

  if (candidates.length === 0) {
    return [];
  }

  const skeleton = candidates.reduce((best, candidate) => (compareForSkeleton(candidate, best) < 0 ? candidate : best));

  const otherRanks = [...new Set(candidates.filter((c) => c !== skeleton).map((c) => c.step.rank))].sort(
    (a, b) => a - b,
  );

  const releaseOf = (candidate: SliceCandidate): number =>
    candidate === skeleton ? 1 : 2 + otherRanks.indexOf(candidate.step.rank);

  // `release` is a bijection over the ranks still holding slices (via otherRanks.indexOf), so two
  // candidates never share a release with different step ranks — sorting by release then doc
  // index already yields (release, step rank, doc index) order.
  return [...candidates]
    .sort((a, b) => releaseOf(a) - releaseOf(b) || a.docIndex - b.docIndex)
    .map((candidate) => ({
      scope: candidate.scope,
      audience,
      outcome,
      constraints,
      nonGoals,
      step: candidate.step,
      release: releaseOf(candidate),
      walkingSkeleton: candidate === skeleton,
    }));
}

/** True when a slice delivers end-to-end value rather than layer-only work. */
export function isVerticalSlice(slice: VerticalSlice): boolean {
  const text = slice.scope.text.toLowerCase();
  return slice.outcome.length > 0 && !HORIZONTAL_CUES.some((cue) => text.includes(cue));
}
