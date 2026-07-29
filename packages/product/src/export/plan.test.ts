// packages/product/src/export/plan.test.ts (#476).

import { CONTRACTS_SCHEMA_VERSION, type AdrDraft, type DesignArtifact, type Epic, type Story } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import type { Decomposition } from '../decompose/index.js';
import type { IntentDoc } from '../intent/index.js';
import type { JudgeReport } from '../judge/index.js';
import type { HandoffDecision, ProposerArtifacts } from '../readiness/index.js';
import { assessReadiness, gateHandoff } from '../readiness/index.js';
import { planExport } from './plan.js';

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

function buildJudgeReport(): JudgeReport {
  return {
    stories: [
      {
        story: STORY,
        verdict: { score: 100, rationale: 'All checks passed.', checks: [] },
        iterations: 0,
        stopReason: 'passed',
        scoreHistory: [100],
      },
    ],
    threshold: 80,
    maxIterations: 3,
    allPassed: true,
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

function readyArtifacts(): ProposerArtifacts {
  return {
    intent: DOC,
    decomposition: DECOMPOSITION,
    epicArchitecture: DESIGN_ARTIFACT,
    designCritique: buildJudgeReport(),
    adrConformance: { drafts: [ADR_DRAFT], unrecordedDecisions: [] },
  };
}

describe('planExport', () => {
  it('refuses to plan on a not-ok handoff decision, passing the blockers through verbatim', () => {
    const decision: HandoffDecision = {
      ok: false,
      report: assessReadiness({}),
      blockers: ['intent doc missing', 'decomposition missing'],
    };
    const result = planExport(readyArtifacts(), decision);

    expect(result).toEqual({ ok: false, blockers: decision.blockers });
  });

  it('refuses to plan when the artifacts have no decomposition even if the decision is ok', () => {
    const { decomposition: _omit, ...artifacts } = readyArtifacts();
    const report = assessReadiness(readyArtifacts());
    const decision: HandoffDecision = { ok: true, report, approvedBy: 'Pat' };

    const result = planExport(artifacts, decision);

    expect(result).toEqual({ ok: false, blockers: ['export needs a decomposition — nothing to file'] });
  });

  it('builds a plan whose epic/stories reference the decomposition and whose bundle has the expected paths, via the real gate', () => {
    const artifacts = readyArtifacts();
    const report = assessReadiness(artifacts);
    const decision = gateHandoff(report, 'Pat');

    const result = planExport(artifacts, decision);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.epic).toBe(DECOMPOSITION.epic);
      expect(result.plan.stories).toBe(DECOMPOSITION.stories);
      expect(result.plan.bundle.files.map((f) => f.path)).toEqual([
        'intent.md',
        'issues/epic.md',
        'issues/story-01.md',
        'architecture.md',
        'adr-drafts/draft-01-use-a-readiness-module.md',
        'readiness.md',
      ]);
    }
  });
});
