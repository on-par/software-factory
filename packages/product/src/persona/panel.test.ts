// packages/product/src/persona/panel.test.ts (#473).

import { CONTRACTS_SCHEMA_VERSION, type Epic } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import { decomposeIntent } from '../decompose/index.js';
import { approveIntentDoc, buildIntentDoc, checkTraceability, type IntentDoc } from '../intent/index.js';
import type { InterviewResult } from '../interview/index.js';
import { PERSONA_IDS } from './findings.js';
import { runPersonaPanel } from './panel.js';

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

const BARE_DOC = approvedDoc(FULL_TRANSCRIPT);
const BARE_RESULT = decomposeIntent(BARE_DOC);
if (!BARE_RESULT.ok) {
  throw new Error(`test fixture could not decompose: ${BARE_RESULT.blockers.join('; ')}`);
}
const BARE_DECOMPOSITION = BARE_RESULT.decomposition;

describe('runPersonaPanel', () => {
  it('Gherkin: given a decomposition, when the persona panel runs, then it returns findings tagged by persona (eng/customer/support/security/ops) and each finding is actionable', () => {
    const report = runPersonaPanel(BARE_DECOMPOSITION, BARE_DOC);

    expect(new Set(report.findings.map((f) => f.persona))).toEqual(new Set(PERSONA_IDS));
    for (const finding of report.findings) {
      if (finding.action.kind === 'question') {
        expect(finding.action.text.trim().length).toBeGreaterThan(0);
      } else {
        expect(finding.action.criterion.when.length).toBeGreaterThan(0);
        expect(finding.action.criterion.then.length).toBeGreaterThan(0);
      }
    }
  });

  it('every finding has a kind that is one of the four FindingKind values and a subject matching a story title', () => {
    const report = runPersonaPanel(BARE_DECOMPOSITION, BARE_DOC);
    const titles = new Set(BARE_DECOMPOSITION.stories.map((s) => s.title));
    for (const finding of report.findings) {
      expect(['gap', 'risk', 'assumption', 'dependency']).toContain(finding.kind);
      expect(titles.has(finding.subject)).toBe(true);
    }
  });

  it('every finding traces only to intent statement IDs defined in the doc', () => {
    const report = runPersonaPanel(BARE_DECOMPOSITION, BARE_DOC);
    const trace = checkTraceability(BARE_DOC, report.findings);
    expect(trace.unknownIds).toEqual([]);
  });

  it('is deterministic — two calls on the same decomposition and doc are deep-equal', () => {
    expect(runPersonaPanel(BARE_DECOMPOSITION, BARE_DOC)).toEqual(runPersonaPanel(BARE_DECOMPOSITION, BARE_DOC));
  });

  it('lists personas in canonical PERSONA_IDS order with no zero-finding persona included', () => {
    const report = runPersonaPanel(BARE_DECOMPOSITION, BARE_DOC);
    const expectedOrder = PERSONA_IDS.filter((id) => report.findings.some((f) => f.persona === id));
    expect(report.personas).toEqual(expectedOrder);
    for (const persona of report.personas) {
      expect(report.findings.some((f) => f.persona === persona)).toBe(true);
    }
  });

  it('returns a clean report for a decomposition with zero stories', () => {
    const epic: Epic = {
      schemaVersion: CONTRACTS_SCHEMA_VERSION,
      kind: 'epic',
      title: 'Empty epic',
      why: 'no stories',
      doneWhen: ['nothing'],
      children: [],
      labels: [],
      tracesTo: [],
    };
    const report = runPersonaPanel({ epic, stories: [] }, BARE_DOC);
    expect(report).toEqual({ findings: [], personas: [], clean: true });
  });
});
