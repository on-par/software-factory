// packages/product/src/export/bundle.test.ts (#476).

import { CONTRACTS_SCHEMA_VERSION, type AdrDraft, type DesignArtifact, type Epic, type Story } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import type { Decomposition } from '../decompose/index.js';
import type { IntentDoc } from '../intent/index.js';
import type { JudgeReport } from '../judge/index.js';
import type { AdrConformanceEvidence, ProposerArtifacts } from '../readiness/index.js';
import { assessReadiness } from '../readiness/index.js';
import { adrDraftFile, buildDesignBundle, renderEpicArchitecture } from './bundle.js';

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

const STORY_1 = buildStory({ title: 'Story One' });
const STORY_2 = buildStory({ title: 'Story Two' });

const EPIC: Epic = {
  schemaVersion: CONTRACTS_SCHEMA_VERSION,
  kind: 'epic',
  title: 'Epic',
  why: 'why',
  doneWhen: ['done'],
  children: [STORY_1.title, STORY_2.title],
  labels: [],
  tracesTo: [],
};

const DECOMPOSITION: Decomposition = { epic: EPIC, stories: [STORY_1, STORY_2] };

const FULL_DESIGN_ARTIFACT: DesignArtifact = {
  restatedProblem: 'problem restated',
  approach: { chosen: 'chosen approach', rejected: [{ option: 'alt', reason: 'worse' }] },
  interfacesTouched: ['some/file.ts'],
  targetTypes: [{ name: 'Thing', file: 'some/file.ts', kind: 'added' }],
  signatures: [{ symbol: 'doThing', file: 'some/file.ts', signature: '() => void' }],
  callGraph: [{ from: 'a', to: 'b', note: 'calls b' }],
  behaviorContract: ['does the thing'],
  verificationPlan: [{ command: 'npm test', passWhen: 'green' }],
  riskBlastRadius: 'small',
  openQuestions: ['what about x?'],
};

const MINIMAL_DESIGN_ARTIFACT: DesignArtifact = {
  restatedProblem: 'problem restated',
  approach: { chosen: 'chosen approach', rejected: [] },
  interfacesTouched: [],
  targetTypes: [],
  signatures: [],
  callGraph: [],
  behaviorContract: ['does the thing'],
  verificationPlan: [{ command: 'npm test', passWhen: 'green' }],
  riskBlastRadius: 'small',
  openQuestions: [],
};

function buildJudgeReport(): JudgeReport {
  const stories = [
    {
      story: STORY_1,
      verdict: { score: 100, rationale: 'All checks passed.', checks: [] },
      iterations: 0,
      stopReason: 'passed' as const,
      scoreHistory: [100],
    },
  ];
  return { stories, threshold: 80, maxIterations: 3, allPassed: true };
}

const ADR_DRAFT_1: AdrDraft = {
  title: 'Use a readiness module',
  context: 'proposer artifacts need a deterministic gate',
  decision: 'add packages/product/src/readiness',
  consequences: 'handoff is explicit',
  status: 'proposed',
  references: [{ text: 'Issue #475', url: 'https://example.com/475' }],
};

const ADR_DRAFT_2: AdrDraft = {
  title: 'Force ADR drafts to Proposed status',
  context: 'the factory ADR writer owns promotion',
  decision: 'hard-code status in adrDraftFile',
  consequences: 'drafts never leak into a promoted state',
  status: 'accepted',
  references: [],
};

function readyAdrConformance(overrides: Partial<AdrConformanceEvidence> = {}): AdrConformanceEvidence {
  return { drafts: [ADR_DRAFT_1, ADR_DRAFT_2], unrecordedDecisions: [], ...overrides };
}

function fullArtifacts(): ProposerArtifacts {
  return {
    intent: DOC,
    decomposition: DECOMPOSITION,
    epicArchitecture: FULL_DESIGN_ARTIFACT,
    designCritique: buildJudgeReport(),
    adrConformance: readyAdrConformance(),
  };
}

describe('buildDesignBundle', () => {
  it('emits every bundle file in the exact order and paths for a full artifact set', () => {
    const artifacts = fullArtifacts();
    const report = assessReadiness(artifacts);
    const bundle = buildDesignBundle(artifacts, report);

    expect(bundle.files.map((f) => f.path)).toEqual([
      'intent.md',
      'issues/epic.md',
      'issues/story-01.md',
      'issues/story-02.md',
      'architecture.md',
      'adr-drafts/draft-01-use-a-readiness-module.md',
      'adr-drafts/draft-02-force-adr-drafts-to-proposed-status.md',
      'readiness.md',
    ]);
  });

  it('forces every ADR draft file to Status: Proposed regardless of the draft status, with no Accepted, number, or date', () => {
    const artifacts = fullArtifacts();
    const report = assessReadiness(artifacts);
    const bundle = buildDesignBundle(artifacts, report);

    const draft1 = bundle.files.find((f) => f.path.includes('draft-01'))!;
    const draft2 = bundle.files.find((f) => f.path.includes('draft-02'))!;

    for (const file of [draft1, draft2]) {
      expect(file.content).toContain('- Status: Proposed');
      expect(file.content).not.toContain('Accepted');
      expect(file.content).not.toMatch(/^# ADR-\d+/);
      expect(file.content).not.toContain('- Date:');
    }

    expect(draft1.content.startsWith(`# ${ADR_DRAFT_1.title}`)).toBe(true);
    expect(draft1.content).toContain('- [Issue #475](https://example.com/475)');
    expect(draft2.content).not.toContain('## References');
  });

  it('renders story bundle files with no "Part of #" line', () => {
    const artifacts = fullArtifacts();
    const report = assessReadiness(artifacts);
    const bundle = buildDesignBundle(artifacts, report);

    const story1 = bundle.files.find((f) => f.path === 'issues/story-01.md')!;
    const story2 = bundle.files.find((f) => f.path === 'issues/story-02.md')!;
    expect(story1.content).not.toContain('Part of #');
    expect(story2.content).not.toContain('Part of #');
  });

  it('omits files whose optional artifact is absent, while readiness.md is always present', () => {
    const { epicArchitecture: _omitArch, adrConformance: _omitAdr, intent: _omitIntent, ...rest } = fullArtifacts();
    const artifacts: ProposerArtifacts = rest;
    const report = assessReadiness(artifacts);
    const bundle = buildDesignBundle(artifacts, report);

    const paths = bundle.files.map((f) => f.path);
    expect(paths).not.toContain('intent.md');
    expect(paths).not.toContain('architecture.md');
    expect(paths.some((p) => p.startsWith('adr-drafts/'))).toBe(false);
    expect(paths).toContain('readiness.md');
  });

  it('omits the decomposition-derived files entirely when there is no decomposition', () => {
    const { decomposition: _omit, ...rest } = fullArtifacts();
    const artifacts: ProposerArtifacts = rest;
    const report = assessReadiness(artifacts);
    const bundle = buildDesignBundle(artifacts, report);

    const paths = bundle.files.map((f) => f.path);
    expect(paths.some((p) => p.startsWith('issues/'))).toBe(false);
  });
});

describe('adrDraftFile', () => {
  it('renders the path with a zero-padded ordinal and slugged title', () => {
    const file = adrDraftFile(ADR_DRAFT_1, 3);
    expect(file.path).toBe('adr-drafts/draft-03-use-a-readiness-module.md');
  });

  it('renders a plain-text reference without a url as "- text"', () => {
    const draft: AdrDraft = { ...ADR_DRAFT_1, references: [{ text: 'internal note' }] };
    const file = adrDraftFile(draft, 1);
    expect(file.content).toContain('- internal note');
    expect(file.content).not.toContain('[internal note]');
  });
});

describe('renderEpicArchitecture', () => {
  it('renders every populated section', () => {
    const lines = renderEpicArchitecture(FULL_DESIGN_ARTIFACT).join('\n');

    expect(lines).toContain('## Problem\nproblem restated');
    expect(lines).toContain('## Approach\nchosen approach');
    expect(lines).toContain('Rejected:\n- alt — worse');
    expect(lines).toContain('## Interfaces touched\n- some/file.ts');
    expect(lines).toContain('## Target types\n- Thing (added) — some/file.ts');
    expect(lines).toContain('## Signatures\n- doThing — () => void');
    expect(lines).toContain('## Call graph\n- a -> b: calls b');
    expect(lines).toContain('## Behavior contract\n- does the thing');
    expect(lines).toContain('## Verification\n- npm test — passes when: green');
    expect(lines).toContain('## Risk / blast radius\nsmall');
    expect(lines).toContain('## Open questions\n- what about x?');
  });

  it('skips targetTypes/signatures/callGraph sections and prints "None." for empty openQuestions', () => {
    const lines = renderEpicArchitecture(MINIMAL_DESIGN_ARTIFACT).join('\n');

    expect(lines).not.toContain('## Target types');
    expect(lines).not.toContain('## Signatures');
    expect(lines).not.toContain('## Call graph');
    expect(lines).not.toContain('Rejected:');
    expect(lines).toContain('## Open questions\nNone.');
  });

  it('renders a call graph edge without a note using only "from -> to"', () => {
    const artifact: DesignArtifact = {
      ...MINIMAL_DESIGN_ARTIFACT,
      callGraph: [{ from: 'a', to: 'b' }],
    };
    const lines = renderEpicArchitecture(artifact).join('\n');
    expect(lines).toContain('- a -> b\n');
  });
});
