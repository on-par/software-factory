// packages/product/src/intent/trace.test.ts (#471).

import type { Traceable } from '@on-par/contracts';
import { StorySchema } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import type { InterviewResult } from '../interview/index.js';
import { buildIntentDoc } from './intent-doc.js';
import { checkTraceability } from './trace.js';

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

const DOC = buildIntentDoc(
  buildResult({
    transcript: [
      {
        question: { index: 1, dimension: 'problem', text: 'x?' },
        answer: 'The export breaks weekly.',
        pinned: true,
      },
      {
        question: { index: 2, dimension: 'outcome', text: 'y?' },
        answer: 'Fewer support tickets each week.',
        pinned: true,
      },
    ],
    gaps: [],
  }),
);

describe('checkTraceability', () => {
  it('Gherkin: downstream artifacts can traces-to those IDs — a real Story parsed via StorySchema is accepted', () => {
    const [firstId] = DOC.statements.map((s) => s.id);
    const story = StorySchema.parse({
      schemaVersion: 1,
      kind: 'story',
      title: 'A story',
      problemStatement: 'The export breaks weekly.',
      inScope: ['x'],
      outOfScope: [],
      acceptanceCriteria: [{ name: 'n', given: ['g'], when: ['w'], then: ['t'] }],
      verification: [{ command: 'echo', passWhen: 'ok' }],
      filesLikelyTouched: ['x'],
      labels: [],
      role: 'PM',
      want: 'a story',
      soThat: 'it ships',
      tracesTo: [firstId],
    });

    const report = checkTraceability(DOC, [story]);
    expect(report.unknownIds).toEqual([]);
  });

  it('is ok with both lists empty when every statement is referenced', () => {
    const artifacts: Traceable[] = DOC.statements.map((s) => ({ tracesTo: [s.id] }));
    const report = checkTraceability(DOC, artifacts);
    expect(report).toEqual({ ok: true, unknownIds: [], untracedIds: [] });
  });

  it('reports a reference to an ID the doc does not define in unknownIds', () => {
    const report = checkTraceability(DOC, [{ tracesTo: ['INT-PROBLEM-99'] }]);
    expect(report.ok).toBe(false);
    expect(report.unknownIds).toEqual(['INT-PROBLEM-99']);
  });

  it('lands a malformed reference in unknownIds', () => {
    const report = checkTraceability(DOC, [{ tracesTo: ['nope'] }]);
    expect(report.unknownIds).toEqual(['nope']);
  });

  it('de-duplicates the same unknown reference cited by two artifacts', () => {
    const report = checkTraceability(DOC, [{ tracesTo: ['INT-PROBLEM-99'] }, { tracesTo: ['INT-PROBLEM-99'] }]);
    expect(report.unknownIds).toEqual(['INT-PROBLEM-99']);
  });

  it('treats an artifact with tracesTo omitted as citing nothing', () => {
    const report = checkTraceability(DOC, [{}]);
    expect(report.unknownIds).toEqual([]);
    expect(report.untracedIds.length).toBe(DOC.statements.length);
  });

  it('lists statements nothing references in untracedIds, in doc order', () => {
    const report = checkTraceability(DOC, []);
    expect(report.ok).toBe(false);
    expect(report.untracedIds).toEqual(DOC.statements.map((s) => s.id));
  });
});
