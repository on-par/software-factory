// packages/product/src/readiness/report.test.ts (#475).

import { CONTRACTS_SCHEMA_VERSION, type AdrDraft, type DesignArtifact, type Epic, type Story } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import type { Decomposition } from '../decompose/index.js';
import type { IntentDoc } from '../intent/index.js';
import type { JudgeReport, JudgedStory } from '../judge/index.js';
import type { AdrConformanceEvidence, ProposerArtifacts } from './artifacts.js';
import { assessReadiness, READINESS_DIMENSION_IDS } from './report.js';

const DOC: IntentDoc = {
  brainDump: 'brain dump',
  statements: [
    { id: 'INT-PROBLEM-01', dimension: 'problem', text: 'p', source: 'answer' },
    { id: 'INT-AUDIENCE-01', dimension: 'audience', text: 'a', source: 'answer' },
    { id: 'INT-OUTCOME-01', dimension: 'outcome', text: 'o', source: 'answer' },
    { id: 'INT-SCOPE-01', dimension: 'scope', text: 's', source: 'answer' },
  ],
  gaps: [],
  status: 'approved',
  approvedBy: 'Pat',
};

function buildStory(overrides: Partial<Story> = {}): Story {
  return {
    schemaVersion: CONTRACTS_SCHEMA_VERSION,
    kind: 'story',
    title: 'A story',
    role: 'user',
    want: 'a thing',
    soThat: 'value happens',
    problemStatement: 'p',
    inScope: ['s'],
    outOfScope: ['n'],
    acceptanceCriteria: [{ name: 'AC', given: [], when: ['x'], then: ['y'], tracesTo: ['INT-SCOPE-01'] }],
    verification: [{ command: 'manual: confirm', passWhen: 'y' }],
    filesLikelyTouched: [],
    labels: [],
    tracesTo: ['INT-SCOPE-01', 'INT-OUTCOME-01'],
    ...overrides,
  };
}

const STORY = buildStory();

const EPIC: Epic = {
  schemaVersion: CONTRACTS_SCHEMA_VERSION,
  kind: 'epic',
  title: 'Epic',
  why: 'why',
  doneWhen: ['done'],
  children: [STORY.title],
  labels: [],
  tracesTo: [],
};

const DECOMPOSITION: Decomposition = { epic: EPIC, stories: [STORY] };

const DESIGN_ARTIFACT: DesignArtifact = {
  restatedProblem: 'problem restated',
  approach: { chosen: 'chosen approach', rejected: [] },
  interfacesTouched: ['some/file.ts'],
  targetTypes: [],
  signatures: [],
  callGraph: [],
  behaviorContract: ['does the thing'],
  verificationPlan: [{ command: 'npm test', passWhen: 'green' }],
  riskBlastRadius: 'small',
  openQuestions: [],
};

function buildJudgedStory(overrides: Partial<JudgedStory> = {}): JudgedStory {
  return {
    story: STORY,
    verdict: { score: 100, rationale: 'All checks passed.', checks: [] },
    iterations: 0,
    stopReason: 'passed',
    scoreHistory: [100],
    ...overrides,
  };
}

function buildJudgeReport(overrides: Partial<JudgeReport> = {}): JudgeReport {
  const stories = overrides.stories ?? [buildJudgedStory()];
  return {
    stories,
    threshold: 80,
    maxIterations: 3,
    allPassed: stories.every((s) => s.stopReason === 'passed'),
    ...overrides,
  };
}

const ADR_DRAFT: AdrDraft = {
  title: 'Use a readiness module',
  context: 'proposer artifacts need a deterministic gate',
  decision: 'add packages/product/src/readiness',
  consequences: 'handoff is explicit',
  status: 'proposed',
  references: [],
};

function readyAdrConformance(overrides: Partial<AdrConformanceEvidence> = {}): AdrConformanceEvidence {
  return { drafts: [ADR_DRAFT], unrecordedDecisions: [], ...overrides };
}

function readyArtifacts(): ProposerArtifacts {
  return {
    intent: DOC,
    decomposition: DECOMPOSITION,
    epicArchitecture: DESIGN_ARTIFACT,
    designCritique: buildJudgeReport(),
    adrConformance: readyAdrConformance(),
  };
}

describe('assessReadiness', () => {
  it('scenario 1: missing epic architecture blocks the technical-design dimension', () => {
    const { epicArchitecture: _omit, ...artifacts } = readyArtifacts();
    const report = assessReadiness(artifacts);

    const technicalDesign = report.dimensions.find((d) => d.id === 'technical-design')!;
    expect(technicalDesign.ready).toBe(false);
    expect(technicalDesign.reason).toContain('epic architecture');
    expect(report.status).toBe('not-ready');
  });

  it('scenario 2: a complete proposer set is ready without any writer-owned artifact', () => {
    const report = assessReadiness(readyArtifacts());

    expect(report.status).toBe('ready');
    expect(report.dimensions.length).toBe(5);
    expect(report.dimensions.every((d) => d.ready)).toBe(true);
    expect(report.dimensions.every((d) => !d.reason.includes('program design'))).toBe(true);
  });

  it('scenario 3: unrecorded decisions and open questions surface as open questions, not blockers', () => {
    const artifacts: ProposerArtifacts = {
      ...readyArtifacts(),
      epicArchitecture: { ...DESIGN_ARTIFACT, openQuestions: ['where does the port lease live?'] },
      adrConformance: readyAdrConformance({ unrecordedDecisions: ['event log schema versioning'] }),
    };
    const report = assessReadiness(artifacts);

    expect(report.status).toBe('ready');
    expect(report.openQuestions).toEqual([
      { text: 'where does the port lease live?', forOwner: 'writer', source: 'epic-architecture' },
      {
        text: 'unrecorded architecture decision: event log schema versioning',
        forOwner: 'writer',
        source: 'adr-conformance',
      },
    ]);
    expect(report.dimensions.every((d) => !d.reason.includes('writer'))).toBe(true);
  });

  it('flips only the intent dimension when the intent doc is missing', () => {
    const { intent: _omit, ...artifacts } = readyArtifacts();
    const report = assessReadiness(artifacts);

    const intent = report.dimensions.find((d) => d.id === 'intent')!;
    expect(intent.ready).toBe(false);
    expect(intent.reason).toBe('intent doc missing');
    expect(report.status).toBe('not-ready');
    expect(report.dimensions.filter((d) => !d.ready)).toHaveLength(1);
  });

  it('flips only the intent dimension when the intent doc is a draft', () => {
    const artifacts: ProposerArtifacts = { ...readyArtifacts(), intent: { ...DOC, status: 'draft' } };
    const report = assessReadiness(artifacts);

    const intent = report.dimensions.find((d) => d.id === 'intent')!;
    expect(intent.ready).toBe(false);
    expect(intent.reason).toContain('human gate #1');
    expect(report.status).toBe('not-ready');
  });

  it('flips only the decomposition dimension when the decomposition is missing', () => {
    const { decomposition: _omit, ...artifacts } = readyArtifacts();
    const report = assessReadiness(artifacts);

    const decomposition = report.dimensions.find((d) => d.id === 'decomposition')!;
    expect(decomposition.ready).toBe(false);
    expect(decomposition.reason).toBe('decomposition missing');
    expect(report.dimensions.filter((d) => !d.ready)).toHaveLength(1);
  });

  it('flips only the decomposition dimension when there are no stories', () => {
    const artifacts: ProposerArtifacts = { ...readyArtifacts(), decomposition: { epic: EPIC, stories: [] } };
    const report = assessReadiness(artifacts);

    const decomposition = report.dimensions.find((d) => d.id === 'decomposition')!;
    expect(decomposition.ready).toBe(false);
    expect(decomposition.reason).toBe('decomposition has no stories');
  });

  it('flips only the design-critique dimension when it is missing', () => {
    const { designCritique: _omit, ...artifacts } = readyArtifacts();
    const report = assessReadiness(artifacts);

    const critique = report.dimensions.find((d) => d.id === 'design-critique')!;
    expect(critique.ready).toBe(false);
    expect(critique.reason).toBe('epic-design critic result missing');
    expect(report.dimensions.filter((d) => !d.ready)).toHaveLength(1);
  });

  it('flips only the design-critique dimension when a story did not pass', () => {
    const failedStory = buildJudgedStory({ stopReason: 'max-iterations' });
    const artifacts: ProposerArtifacts = {
      ...readyArtifacts(),
      designCritique: buildJudgeReport({ stories: [failedStory] }),
    };
    const report = assessReadiness(artifacts);

    const critique = report.dimensions.find((d) => d.id === 'design-critique')!;
    expect(critique.ready).toBe(false);
    expect(critique.reason).toBe('1 of 1 stories did not pass the epic-design critic');
  });

  it('flips only the adr-conformance dimension when it is missing', () => {
    const { adrConformance: _omit, ...artifacts } = readyArtifacts();
    const report = assessReadiness(artifacts);

    const adr = report.dimensions.find((d) => d.id === 'adr-conformance')!;
    expect(adr.ready).toBe(false);
    expect(adr.reason).toBe('ADR conformance evidence missing');
    expect(report.dimensions.filter((d) => !d.ready)).toHaveLength(1);
  });

  it('flips only the adr-conformance dimension when a draft has a blank context', () => {
    const artifacts: ProposerArtifacts = {
      ...readyArtifacts(),
      adrConformance: readyAdrConformance({ drafts: [{ ...ADR_DRAFT, context: '  ' }] }),
    };
    const report = assessReadiness(artifacts);

    const adr = report.dimensions.find((d) => d.id === 'adr-conformance')!;
    expect(adr.ready).toBe(false);
    expect(adr.reason).toContain(ADR_DRAFT.title);
  });

  it('names the draft ordinal when a non-conforming draft has a blank title', () => {
    const artifacts: ProposerArtifacts = {
      ...readyArtifacts(),
      adrConformance: readyAdrConformance({ drafts: [{ ...ADR_DRAFT, title: '   ', decision: '' }] }),
    };
    const report = assessReadiness(artifacts);

    const adr = report.dimensions.find((d) => d.id === 'adr-conformance')!;
    expect(adr.ready).toBe(false);
    expect(adr.reason).toContain('draft #1');
  });

  it('is deterministic: two calls with the same input produce deeply-equal reports', () => {
    const artifacts = readyArtifacts();
    expect(assessReadiness(artifacts)).toEqual(assessReadiness(artifacts));
  });

  it('always returns exactly the five dimensions in fixed order', () => {
    const report = assessReadiness(readyArtifacts());
    expect(report.dimensions.map((d) => d.id)).toEqual(READINESS_DIMENSION_IDS);
  });

  it('skips blank open-question and unrecorded-decision strings', () => {
    const artifacts: ProposerArtifacts = {
      ...readyArtifacts(),
      epicArchitecture: { ...DESIGN_ARTIFACT, openQuestions: ['  ', ''] },
      adrConformance: readyAdrConformance({ unrecordedDecisions: ['   '] }),
    };
    const report = assessReadiness(artifacts);

    expect(report.openQuestions).toEqual([]);
  });
});
