// packages/product/src/architecture/design.test.ts (#477).
import { CONTRACTS_SCHEMA_VERSION, DesignArtifactSchema, type Epic, type Story } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import type { Decomposition } from '../decompose/index.js';
import type { IntentDoc } from '../intent/index.js';
import { assessReadiness } from '../readiness/index.js';
import type { EpicAdr } from './adrs.js';
import { designEpicArchitecture } from './design.js';
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
  verification: [
    { command: 'npm test', passWhen: 'onboarding works' },
    { command: 'npm run e2e', passWhen: 'onboarding e2e passes' },
  ],
});

const WIDGET_ADR: EpicAdr = {
  label: 'ADR-0001',
  number: 1,
  title: 'Widget architecture',
  path: 'docs/adr/0001-widget-architecture.md',
  decision: 'Widgets are built as packages/widget.',
};

const SURVEY_WITH_WIDGET: RepoSurvey = {
  components: [{ name: 'widget', path: 'packages/widget' }],
  hasAdrHome: true,
};

const EMPTY_SURVEY: RepoSurvey = { components: [], hasAdrHome: false };

describe('designEpicArchitecture', () => {
  it('returns blockers for a draft intent doc', () => {
    const decomposition: Decomposition = { epic: buildEpic([WIDGET_STORY.title]), stories: [WIDGET_STORY] };

    const result = designEpicArchitecture(decomposition, DRAFT_DOC, { adrs: [], survey: EMPTY_SURVEY });

    expect(result).toEqual({
      ok: false,
      blockers: ['the epic designer needs an approved intent doc (human gate #1)'],
    });
  });

  it('returns blockers for a story-less decomposition', () => {
    const decomposition: Decomposition = { epic: buildEpic([]), stories: [] };

    const result = designEpicArchitecture(decomposition, APPROVED_DOC, { adrs: [], survey: EMPTY_SURVEY });

    expect(result).toEqual({
      ok: false,
      blockers: ['the epic designer needs at least one story to bound'],
    });
  });

  it('returns both blockers when the doc is a draft and there are no stories', () => {
    const decomposition: Decomposition = { epic: buildEpic([]), stories: [] };

    const result = designEpicArchitecture(decomposition, DRAFT_DOC, { adrs: [], survey: EMPTY_SURVEY });

    expect(result).toEqual({
      ok: false,
      blockers: [
        'the epic designer needs an approved intent doc (human gate #1)',
        'the epic designer needs at least one story to bound',
      ],
    });
  });

  it('conforms constraints to active ADRs and flags an unbacked decision as a deviation', () => {
    const decomposition: Decomposition = {
      epic: buildEpic([WIDGET_STORY.title, ONBOARDING_STORY.title]),
      stories: [WIDGET_STORY, ONBOARDING_STORY],
    };

    const result = designEpicArchitecture(decomposition, APPROVED_DOC, {
      adrs: [WIDGET_ADR],
      survey: SURVEY_WITH_WIDGET,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { artifact, constraints, deviations } = result.architecture;

    expect(artifact.behaviorContract).toContain(
      'ADR-0001 — Widget architecture: Widgets are built as packages/widget.',
    );
    expect(constraints.some((c) => c.adr === 'ADR-0001' && c.text.includes('per ADR-0001'))).toBe(true);

    expect(deviations).toEqual([
      { subject: 'improve onboarding flow', text: 'introduce a new component for story "Improve onboarding flow"' },
    ]);
    expect(artifact.openQuestions).toEqual([
      'needs a new ADR: introduce a new component for story "Improve onboarding flow"',
    ]);
  });

  it('touches interfaces and backs the decision when a story mentions a survey component', () => {
    const decomposition: Decomposition = { epic: buildEpic([WIDGET_STORY.title]), stories: [WIDGET_STORY] };

    const result = designEpicArchitecture(decomposition, APPROVED_DOC, {
      adrs: [WIDGET_ADR],
      survey: SURVEY_WITH_WIDGET,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.architecture.artifact.interfacesTouched).toEqual(['packages/widget']);
    const decisionConstraint = result.architecture.constraints.find((c) =>
      c.text.startsWith('change component widget'),
    );
    expect(decisionConstraint).toEqual({
      text: 'change component widget (packages/widget) (per ADR-0001)',
      adr: 'ADR-0001',
    });
    expect(result.architecture.deviations).toEqual([]);
  });

  it('introduces a new component decision when a story matches no survey component', () => {
    const decomposition: Decomposition = { epic: buildEpic([ONBOARDING_STORY.title]), stories: [ONBOARDING_STORY] };

    const result = designEpicArchitecture(decomposition, APPROVED_DOC, { adrs: [], survey: EMPTY_SURVEY });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.architecture.artifact.interfacesTouched).toEqual([]);
    expect(result.architecture.deviations).toEqual([
      { subject: 'improve onboarding flow', text: 'introduce a new component for story "Improve onboarding flow"' },
    ]);
  });

  it('aggregates verification steps in story order, deduped by command', () => {
    const decomposition: Decomposition = {
      epic: buildEpic([WIDGET_STORY.title, ONBOARDING_STORY.title]),
      stories: [WIDGET_STORY, ONBOARDING_STORY],
    };

    const result = designEpicArchitecture(decomposition, APPROVED_DOC, {
      adrs: [WIDGET_ADR],
      survey: SURVEY_WITH_WIDGET,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.architecture.artifact.verificationPlan).toEqual([
      { command: 'npm test', passWhen: 'widgets work' },
      { command: 'npm run e2e', passWhen: 'onboarding e2e passes' },
    ]);
  });

  it('produces an artifact that passes DesignArtifactSchema.parse', () => {
    const decomposition: Decomposition = { epic: buildEpic([WIDGET_STORY.title]), stories: [WIDGET_STORY] };

    const result = designEpicArchitecture(decomposition, APPROVED_DOC, {
      adrs: [WIDGET_ADR],
      survey: SURVEY_WITH_WIDGET,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => DesignArtifactSchema.parse(result.architecture.artifact)).not.toThrow();
  });

  it('is deterministic — identical inputs yield deep-equal outputs', () => {
    const decomposition: Decomposition = {
      epic: buildEpic([WIDGET_STORY.title, ONBOARDING_STORY.title]),
      stories: [WIDGET_STORY, ONBOARDING_STORY],
    };
    const context = { adrs: [WIDGET_ADR], survey: SURVEY_WITH_WIDGET };

    const first = designEpicArchitecture(decomposition, APPROVED_DOC, context);
    const second = designEpicArchitecture(decomposition, APPROVED_DOC, context);

    expect(first).toEqual(second);
  });

  it('describes no active ADRs and no touched components when there are none', () => {
    const decomposition: Decomposition = { epic: buildEpic([ONBOARDING_STORY.title]), stories: [ONBOARDING_STORY] };

    const result = designEpicArchitecture(decomposition, APPROVED_DOC, { adrs: [], survey: EMPTY_SURVEY });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.architecture.artifact.approach.chosen).toBe(
      'Deliver epic "Add widget support" as 1 vertical slice(s), introducing new component(s), with no ADR home found in the target repo',
    );
  });

  it('describes touched components and active ADR count when both are present', () => {
    const decomposition: Decomposition = { epic: buildEpic([WIDGET_STORY.title]), stories: [WIDGET_STORY] };

    const result = designEpicArchitecture(decomposition, APPROVED_DOC, {
      adrs: [WIDGET_ADR],
      survey: SURVEY_WITH_WIDGET,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.architecture.artifact.approach.chosen).toBe(
      'Deliver epic "Add widget support" as 1 vertical slice(s), touching widget, bounded by 1 active ADR(s)',
    );
  });

  it('condenses a long ADR decision to 300 characters with an ellipsis', () => {
    const longDecision = `${'a'.repeat(310)}`;
    const longAdr: EpicAdr = { ...WIDGET_ADR, decision: longDecision };
    const decomposition: Decomposition = { epic: buildEpic([WIDGET_STORY.title]), stories: [WIDGET_STORY] };

    const result = designEpicArchitecture(decomposition, APPROVED_DOC, { adrs: [longAdr], survey: SURVEY_WITH_WIDGET });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const adrConstraint = result.architecture.constraints.find((c) => c.text.startsWith('ADR-0001 —'));
    expect(adrConstraint?.text).toBe(`ADR-0001 — Widget architecture: ${'a'.repeat(300)}…`);
  });

  it('flows the epic architecture artifact into readiness as technical-design ready with forwarded open questions', () => {
    const decomposition: Decomposition = {
      epic: buildEpic([WIDGET_STORY.title, ONBOARDING_STORY.title]),
      stories: [WIDGET_STORY, ONBOARDING_STORY],
    };

    const result = designEpicArchitecture(decomposition, APPROVED_DOC, {
      adrs: [WIDGET_ADR],
      survey: SURVEY_WITH_WIDGET,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const report = assessReadiness({ epicArchitecture: result.architecture.artifact });

    const technicalDesign = report.dimensions.find((d) => d.id === 'technical-design');
    expect(technicalDesign?.ready).toBe(true);

    expect(report.openQuestions).toEqual([
      {
        text: 'needs a new ADR: introduce a new component for story "Improve onboarding flow"',
        forOwner: 'writer',
        source: 'epic-architecture',
      },
    ]);
  });
});
