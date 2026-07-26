// packages/product/src/decompose/decompose.test.ts (#472).

import { EpicSchema, StorySchema } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import { approveIntentDoc, buildIntentDoc, checkTraceability, type IntentDoc } from '../intent/index.js';
import type { InterviewResult } from '../interview/index.js';
import { decomposeIntent, traceablesOf } from './decompose.js';

function buildResult(overrides: Partial<InterviewResult>): InterviewResult {
  return {
    brainDump: '',
    coveredByDump: [],
    transcript: [],
    pinned: [],
    gaps: [],
    stopReason: 'pinned',
    questionsAsked: 0,
    questionBudget: 6,
    ...overrides,
  };
}

const FULL_TRANSCRIPT: InterviewResult['transcript'] = [
  { question: { index: 1, dimension: 'problem', text: 'p?' }, answer: 'The export breaks weekly', pinned: true },
  { question: { index: 2, dimension: 'audience', text: 'a?' }, answer: 'The ops team is affected', pinned: true },
  { question: { index: 3, dimension: 'outcome', text: 'o?' }, answer: 'Fewer support tickets are filed', pinned: true },
  {
    question: { index: 4, dimension: 'scope', text: 's?' },
    answer: 'Build the retry button. Add the retry endpoint.',
    pinned: true,
  },
  {
    question: { index: 5, dimension: 'nonGoals', text: 'n?' },
    answer: 'Automated retries are out of scope',
    pinned: true,
  },
  { question: { index: 6, dimension: 'constraints', text: 'c?' }, answer: 'Ship before the deadline', pinned: true },
];

function approvedDoc(transcript: InterviewResult['transcript']): IntentDoc {
  const doc = buildIntentDoc(buildResult({ transcript, gaps: [] }));
  const approval = approveIntentDoc(doc, 'Pat');
  if (!approval.ok) {
    throw new Error(`test fixture could not approve: ${approval.blockers.join('; ')}`);
  }
  return approval.doc;
}

const FULL_DOC = approvedDoc(FULL_TRANSCRIPT);

describe('decomposeIntent', () => {
  it('Gherkin: given an approved intent doc, decomposeIntent returns one epic and one story per scope statement, and every story and criterion traces to intent', () => {
    const result = decomposeIntent(FULL_DOC);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.decomposition.stories).toHaveLength(2);
    for (const story of result.decomposition.stories) {
      expect(story.tracesTo.length).toBeGreaterThan(0);
      for (const criterion of story.acceptanceCriteria) {
        expect(criterion.tracesTo.length).toBeGreaterThan(0);
      }
    }
  });

  it('emits an epic and stories that parse against EpicSchema and StorySchema', () => {
    const result = decomposeIntent(FULL_DOC);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(() => EpicSchema.parse(result.decomposition.epic)).not.toThrow();
    for (const story of result.decomposition.stories) {
      expect(() => StorySchema.parse(story)).not.toThrow();
    }
  });

  it('satisfies the totality invariant — checkTraceability reports no unknownIds and no untracedIds', () => {
    const result = decomposeIntent(FULL_DOC);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const report = checkTraceability(FULL_DOC, traceablesOf(result.decomposition));
    expect(report).toEqual({ ok: true, unknownIds: [], untracedIds: [] });
  });

  it('is deterministic — two calls on the same doc are deep-equal', () => {
    expect(decomposeIntent(FULL_DOC)).toEqual(decomposeIntent(FULL_DOC));
  });

  it('blocks on a draft (unapproved) doc and emits no artifacts', () => {
    const draft = buildIntentDoc(buildResult({ transcript: FULL_TRANSCRIPT, gaps: [] }));
    const result = decomposeIntent(draft);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.blockers).toContain('the decomposer needs an approved intent doc (human gate #1)');
    expect('decomposition' in result).toBe(false);
  });

  it('blocks on missing problem statements', () => {
    const doc = approvedDoc(FULL_TRANSCRIPT.filter((t) => t.question.dimension !== 'problem'));
    const result = decomposeIntent(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers).toContain('no problem statements — the epic would have no why');
    }
  });

  it('blocks on missing audience statements', () => {
    const doc = approvedDoc(FULL_TRANSCRIPT.filter((t) => t.question.dimension !== 'audience'));
    const result = decomposeIntent(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers).toContain('no audience statements — stories would have no role');
    }
  });

  it('blocks on missing outcome statements', () => {
    const doc = approvedDoc(FULL_TRANSCRIPT.filter((t) => t.question.dimension !== 'outcome'));
    const result = decomposeIntent(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers).toContain('no outcome statements — stories would have no value to trace to');
    }
  });

  it('blocks on missing scope statements', () => {
    const doc = approvedDoc(FULL_TRANSCRIPT.filter((t) => t.question.dimension !== 'scope'));
    const result = decomposeIntent(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers).toContain('no scope statements to slice into stories');
    }
  });

  it('blocks a horizontal scope statement, naming it', () => {
    const transcript = FULL_TRANSCRIPT.map((t) =>
      t.question.dimension === 'scope' ? { ...t, answer: 'Refactor the export pipeline' } : t,
    );
    const doc = approvedDoc(transcript);
    const result = decomposeIntent(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers.some((b) => b.includes('not a vertical slice') && b.includes('Refactor'))).toBe(true);
    }
  });

  it('blocks an INVEST failure — a doc with no nonGoals statements yields an empty outOfScope and a negotiable blocker', () => {
    const doc = approvedDoc(FULL_TRANSCRIPT.filter((t) => t.question.dimension !== 'nonGoals'));
    const result = decomposeIntent(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers.some((b) => b.includes('fails INVEST (negotiable)'))).toBe(true);
    }
  });

  it('truncates a title over 72 characters, ending with an ellipsis', () => {
    const longScope =
      'build a fully automated retry mechanism for every single failed nightly export job across every warehouse and region so ops teams never manually retry them';
    const transcript = FULL_TRANSCRIPT.map((t) => (t.question.dimension === 'scope' ? { ...t, answer: longScope } : t));
    const doc = approvedDoc(transcript);
    const result = decomposeIntent(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const [story] = result.decomposition.stories;
    expect(story.title.endsWith('…')).toBe(true);
    expect(story.title.length).toBeLessThanOrEqual(73);
  });
});
