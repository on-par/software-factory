// packages/product/src/architecture/critic.test.ts (#478).
import { CONTRACTS_SCHEMA_VERSION, DesignArtifactSchema, type Epic, type Story } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import type { Decomposition } from '../decompose/index.js';
import type { IntentDoc } from '../intent/index.js';
import type { EpicAdr } from './adrs.js';
import {
  critiqueEpicArchitecture,
  reworkArchitectureMechanically,
  runEpicDesignCritic,
  type EpicDesignCritic,
  type EpicDesignReworker,
} from './critic.js';
import { designEpicArchitecture, type EpicArchitecture } from './design.js';
import type { RepoSurvey } from './survey.js';

const APPROVED_DOC: IntentDoc = {
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

const DRAFT_DOC: IntentDoc = { ...APPROVED_DOC, status: 'draft', approvedBy: undefined };

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
    outOfScope: [],
    acceptanceCriteria: [{ name: 'AC', given: [], when: ['x'], then: ['y'], tracesTo: ['INT-SCOPE-01'] }],
    verification: [{ command: 'manual: confirm', passWhen: 'y' }],
    filesLikelyTouched: [],
    labels: [],
    tracesTo: ['INT-SCOPE-01', 'INT-OUTCOME-01'],
    ...overrides,
  };
}

function buildEpic(children: string[], overrides: Partial<Epic> = {}): Epic {
  return {
    schemaVersion: CONTRACTS_SCHEMA_VERSION,
    kind: 'epic',
    title: 'Add widget support',
    why: 'users need widgets',
    doneWhen: ['widgets ship'],
    children,
    labels: [],
    tracesTo: [],
    ...overrides,
  };
}

const WIDGET_STORY = buildStory({
  title: 'Add widget',
  want: 'support widgets in the widget package',
  inScope: ['widget UI'],
  verification: [{ command: 'npm test', passWhen: 'widgets work' }],
});

const ONBOARDING_STORY = buildStory({
  title: 'Improve onboarding flow',
  want: 'improve onboarding',
  inScope: ['onboarding copy'],
  verification: [{ command: 'npm test', passWhen: 'onboarding works' }],
});

const WIDGET_ADR: EpicAdr = {
  label: 'ADR-0001',
  number: 1,
  title: 'Widget architecture',
  path: 'docs/adr/0001-widget-architecture.md',
  decision: 'Widgets are built as packages/widget.',
};

const SECOND_ADR: EpicAdr = {
  label: 'ADR-0009',
  number: 9,
  title: 'Second decision',
  path: 'docs/adr/0009-second-decision.md',
  decision: 'Something unrelated to widgets.',
};

const SURVEY_WITH_WIDGET: RepoSurvey = {
  components: [{ name: 'widget', path: 'packages/widget' }],
  hasAdrHome: true,
};

function designArchitecture(
  adrs: readonly EpicAdr[],
  survey: RepoSurvey = SURVEY_WITH_WIDGET,
  story: Story = WIDGET_STORY,
): EpicArchitecture {
  const decomposition: Decomposition = { epic: buildEpic([story.title]), stories: [story] };
  const result = designEpicArchitecture(decomposition, APPROVED_DOC, { adrs, survey });
  if (!result.ok) {
    throw new Error(`fixture setup failed: ${result.blockers.join('; ')}`);
  }
  return result.architecture;
}

// The Gherkin architecture: designed with no active ADRs, so the widget decision becomes an unbacked deviation.
const GHERKIN_ARCHITECTURE = designArchitecture([]);

// An architecture designed against the same active ADR set it is critiqued against — every check should pass.
const PASS_ARCHITECTURE = designArchitecture([WIDGET_ADR]);

describe('critiqueEpicArchitecture', () => {
  it('the Gherkin scenario: an architecture ignoring an active ADR gets rework, naming the ADR', () => {
    const verdict = critiqueEpicArchitecture(GHERKIN_ARCHITECTURE, APPROVED_DOC, [WIDGET_ADR]);

    expect(verdict.verdict).toBe('rework');
    expect(verdict.violatedAdrs).toContain('ADR-0001');
    expect(verdict.checks.find((c) => c.id === 'adrs-covered')?.passed).toBe(false);
    expect(verdict.checks.find((c) => c.id === 'no-adr-conflicts')?.passed).toBe(false);
  });

  it('passes an architecture designed against the same active-ADR set', () => {
    const verdict = critiqueEpicArchitecture(PASS_ARCHITECTURE, APPROVED_DOC, [WIDGET_ADR]);

    expect(verdict).toEqual({
      verdict: 'pass',
      score: 100,
      rationale: 'All 5 checks passed.',
      checks: verdict.checks,
      violatedAdrs: [],
    });
    expect(verdict.checks.every((c) => c.passed)).toBe(true);
  });

  it('fails intent-approved alone on a draft doc', () => {
    const verdict = critiqueEpicArchitecture(PASS_ARCHITECTURE, DRAFT_DOC, [WIDGET_ADR]);

    expect(verdict.verdict).toBe('rework');
    expect(verdict.score).toBe(80);
    const check = verdict.checks.find((c) => c.id === 'intent-approved');
    expect(check?.passed).toBe(false);
    expect(check?.note).toBe('the intent doc is a draft — the critic needs human gate #1');
    expect(verdict.checks.filter((c) => !c.passed)).toHaveLength(1);
  });

  it('fails verification-planned alone on an architecture with an empty verification plan', () => {
    const architecture: EpicArchitecture = {
      ...PASS_ARCHITECTURE,
      artifact: DesignArtifactSchema.parse({ ...PASS_ARCHITECTURE.artifact, verificationPlan: [] }),
    };

    const verdict = critiqueEpicArchitecture(architecture, APPROVED_DOC, [WIDGET_ADR]);

    expect(verdict.verdict).toBe('rework');
    const check = verdict.checks.find((c) => c.id === 'verification-planned');
    expect(check?.passed).toBe(false);
    expect(check?.note).toBe('verificationPlan is empty');
    expect(verdict.checks.filter((c) => !c.passed)).toHaveLength(1);
  });

  it('fails deviations-declared alone when a deviation is missing its open-question line', () => {
    const architecture: EpicArchitecture = {
      ...GHERKIN_ARCHITECTURE,
      artifact: DesignArtifactSchema.parse({ ...GHERKIN_ARCHITECTURE.artifact, openQuestions: [] }),
    };

    // Critiqued with no active ADRs: adrs-covered and no-adr-conflicts are vacuously satisfied.
    const verdict = critiqueEpicArchitecture(architecture, APPROVED_DOC, []);

    expect(verdict.verdict).toBe('rework');
    const check = verdict.checks.find((c) => c.id === 'deviations-declared');
    expect(check?.passed).toBe(false);
    expect(check?.note).toContain(GHERKIN_ARCHITECTURE.deviations[0]!.text);
    expect(verdict.checks.filter((c) => !c.passed)).toHaveLength(1);
  });

  it('returns violatedAdrs sorted, deduped across missing and conflicting ADRs', () => {
    const architecture: EpicArchitecture = {
      artifact: DesignArtifactSchema.parse({
        restatedProblem: 'p',
        approach: { chosen: 'c', rejected: [] },
        interfacesTouched: [],
        targetTypes: [],
        signatures: [],
        callGraph: [],
        behaviorContract: [],
        verificationPlan: [{ command: 'npm test', passWhen: 'ok' }],
        riskBlastRadius: 'r',
        openQuestions: [],
      }),
      constraints: [],
      deviations: [],
    };

    const verdict = critiqueEpicArchitecture(architecture, APPROVED_DOC, [SECOND_ADR, WIDGET_ADR]);

    expect(verdict.violatedAdrs).toEqual(['ADR-0001', 'ADR-0009']);
  });
});

describe('reworkArchitectureMechanically', () => {
  it('fixes the ADR conflict and ADR coverage on the Gherkin architecture, rebuilding the artifact consistently', () => {
    const verdict = critiqueEpicArchitecture(GHERKIN_ARCHITECTURE, APPROVED_DOC, [WIDGET_ADR]);

    const reworked = reworkArchitectureMechanically(GHERKIN_ARCHITECTURE, verdict, APPROVED_DOC, [WIDGET_ADR]);

    expect(reworked).not.toBe(GHERKIN_ARCHITECTURE);
    expect(reworked.deviations).toEqual([]);
    expect(reworked.constraints.some((c) => c.adr === 'ADR-0001')).toBe(true);
    expect(reworked.constraints.some((c) => c.text.endsWith('(per ADR-0001)'))).toBe(true);
    expect(reworked.artifact.behaviorContract).toEqual(reworked.constraints.map((c) => c.text));
    expect(reworked.artifact.openQuestions).toEqual([]);

    // The fix is real: re-critiquing the reworked architecture improves the verdict.
    const reworkedVerdict = critiqueEpicArchitecture(reworked, APPROVED_DOC, [WIDGET_ADR]);
    expect(reworkedVerdict.verdict).toBe('pass');
  });

  it('leaves the architecture unchanged (same reference) when only unfixable checks fail', () => {
    const verdict = critiqueEpicArchitecture(PASS_ARCHITECTURE, DRAFT_DOC, [WIDGET_ADR]);

    const reworked = reworkArchitectureMechanically(PASS_ARCHITECTURE, verdict, DRAFT_DOC, [WIDGET_ADR]);

    expect(reworked).toBe(PASS_ARCHITECTURE);
  });

  it('fixes only the deviation an active ADR backs, leaving an unbacked deviation declared', () => {
    const decomposition: Decomposition = {
      epic: buildEpic([WIDGET_STORY.title, ONBOARDING_STORY.title]),
      stories: [WIDGET_STORY, ONBOARDING_STORY],
    };
    const result = designEpicArchitecture(decomposition, APPROVED_DOC, { adrs: [], survey: SURVEY_WITH_WIDGET });
    if (!result.ok) {
      throw new Error(`fixture setup failed: ${result.blockers.join('; ')}`);
    }
    const architecture = result.architecture;

    const verdict = critiqueEpicArchitecture(architecture, APPROVED_DOC, [WIDGET_ADR]);
    const reworked = reworkArchitectureMechanically(architecture, verdict, APPROVED_DOC, [WIDGET_ADR]);

    expect(reworked.deviations).toEqual([
      { subject: 'improve onboarding flow', text: 'introduce a new component for story "Improve onboarding flow"' },
    ]);
    expect(reworked.constraints.some((c) => c.adr === 'ADR-0001' && c.text.endsWith('(per ADR-0001)'))).toBe(true);
    expect(reworked.artifact.openQuestions).toEqual([
      'needs a new ADR: introduce a new component for story "Improve onboarding flow"',
    ]);
    expect(reworked.artifact.behaviorContract).toEqual(reworked.constraints.map((c) => c.text));
  });
});

describe('runEpicDesignCritic', () => {
  it('returns immediately with iterations: 0 and stopReason "passed" for an already-passing architecture', async () => {
    const result = await runEpicDesignCritic(PASS_ARCHITECTURE, APPROVED_DOC, [WIDGET_ADR]);

    expect(result.iterations).toBe(0);
    expect(result.stopReason).toBe('passed');
    expect(result.scoreHistory).toEqual([100]);
    expect(result.verdict.verdict).toBe('pass');
  });

  it('reworks the Gherkin architecture to a pass in one iteration with default seams', async () => {
    const result = await runEpicDesignCritic(GHERKIN_ARCHITECTURE, APPROVED_DOC, [WIDGET_ADR]);

    expect(result.stopReason).toBe('passed');
    expect(result.iterations).toBe(1);
    expect(result.verdict.verdict).toBe('pass');
    expect(result.scoreHistory).toHaveLength(2);
    expect(result.scoreHistory[1]).toBe(100);
  });

  it('stops with "no-improvement" after one iteration on an unfixable failure, keeping the original best', async () => {
    const result = await runEpicDesignCritic(PASS_ARCHITECTURE, DRAFT_DOC, [WIDGET_ADR]);

    expect(result.stopReason).toBe('no-improvement');
    expect(result.iterations).toBe(1);
    expect(result.architecture).toBe(PASS_ARCHITECTURE);
  });

  it('stops at exactly maxIterations when an adversarial critic keeps "improving" but never passes', async () => {
    let score = 0;
    const alwaysImprovingNeverPassingCritic: EpicDesignCritic = () => {
      score += 1;
      return { verdict: 'rework', score, rationale: 'never satisfied', checks: [], violatedAdrs: [] };
    };
    const identityRework: EpicDesignReworker = (architecture) => architecture;

    const result = await runEpicDesignCritic(
      GHERKIN_ARCHITECTURE,
      APPROVED_DOC,
      [WIDGET_ADR],
      { critic: alwaysImprovingNeverPassingCritic, rework: identityRework },
      { maxIterations: 3 },
    );

    expect(result.stopReason).toBe('max-iterations');
    expect(result.iterations).toBe(3);
    expect(result.scoreHistory).toEqual([1, 2, 3, 4]);
  });

  it('stops immediately at max-iterations with iterations: 0 when maxIterations is 0', async () => {
    const result = await runEpicDesignCritic(PASS_ARCHITECTURE, DRAFT_DOC, [WIDGET_ADR], {}, { maxIterations: 0 });

    expect(result.stopReason).toBe('max-iterations');
    expect(result.iterations).toBe(0);
    expect(result.scoreHistory).toEqual([80]);
  });

  it('throws the exact message for a negative maxIterations', async () => {
    await expect(
      runEpicDesignCritic(PASS_ARCHITECTURE, DRAFT_DOC, [WIDGET_ADR], {}, { maxIterations: -1 }),
    ).rejects.toThrow('epic-design critic: maxIterations must be a non-negative integer');
  });

  it('throws the exact message for a non-integer maxIterations', async () => {
    await expect(
      runEpicDesignCritic(PASS_ARCHITECTURE, DRAFT_DOC, [WIDGET_ADR], {}, { maxIterations: 1.5 }),
    ).rejects.toThrow('epic-design critic: maxIterations must be a non-negative integer');
  });

  it('works with async (Promise-returning) critic and reworker seams', async () => {
    const asyncCritic: EpicDesignCritic = async (architecture, doc, adrs) =>
      Promise.resolve(critiqueEpicArchitecture(architecture, doc, adrs));
    const asyncRework: EpicDesignReworker = async (architecture, verdict, doc, adrs) =>
      Promise.resolve(reworkArchitectureMechanically(architecture, verdict, doc, adrs));

    const result = await runEpicDesignCritic(GHERKIN_ARCHITECTURE, APPROVED_DOC, [WIDGET_ADR], {
      critic: asyncCritic,
      rework: asyncRework,
    });

    expect(result.stopReason).toBe('passed');
    expect(result.verdict.verdict).toBe('pass');
  });
});
