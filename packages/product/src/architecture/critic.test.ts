// packages/product/src/architecture/critic.test.ts (#478).
import { CONTRACTS_SCHEMA_VERSION, DesignArtifactSchema, type Epic, type Story } from '@on-par/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { Decomposition } from '../decompose/index.js';
import type { IntentDoc } from '../intent/index.js';
import type { RubricCheck } from '../judge/index.js';
import type { EpicAdr } from './adrs.js';
import {
  critiqueEpicDesign,
  critiqueEpicDesignAgainstAdrs,
  reworkEpicArchitectureMechanically,
  type DesignCriticVerdict,
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
    verification: [{ command: 'npm test', passWhen: 'widgets work' }],
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

const WIDGET_STORY = buildStory({ title: 'Add widget', want: 'support widgets', inScope: ['widget UI'] });

const ADR_0004: EpicAdr = {
  label: 'ADR-0004',
  number: 4,
  title: 'Narrow public core API',
  path: 'docs/adr/0004-narrow-public-core-api.md',
  decision: 'Only export the narrow API from core.',
};

const EMPTY_SURVEY: RepoSurvey = { components: [], hasAdrHome: true };

function buildConformingArchitecture(): EpicArchitecture {
  const decomposition: Decomposition = { epic: buildEpic([WIDGET_STORY.title]), stories: [WIDGET_STORY] };
  const result = designEpicArchitecture(decomposition, APPROVED_DOC, { adrs: [ADR_0004], survey: EMPTY_SURVEY });
  if (!result.ok) {
    throw new Error(`fixture setup failed: ${result.blockers.join('; ')}`);
  }
  return result.architecture;
}

const CONFORMING_ARCHITECTURE = buildConformingArchitecture();

/** CONFORMING_ARCHITECTURE with its ADR-0004 constraint removed, but the artifact left untouched. */
function buildArchitectureMissingAdr(): EpicArchitecture {
  return {
    ...CONFORMING_ARCHITECTURE,
    constraints: CONFORMING_ARCHITECTURE.constraints.filter((c) => c.adr !== 'ADR-0004'),
  };
}

/** CONFORMING_ARCHITECTURE with its unbacked decision constraint re-labeled to a retired ADR. */
function buildArchitectureWithStaleCitation(): EpicArchitecture {
  return {
    ...CONFORMING_ARCHITECTURE,
    constraints: CONFORMING_ARCHITECTURE.constraints.map((c) => (c.adr === undefined ? { ...c, adr: 'ADR-9999' } : c)),
  };
}

/** CONFORMING_ARCHITECTURE with its deviation's open question dropped. */
function buildArchitectureMissingOpenQuestion(): EpicArchitecture {
  return { ...CONFORMING_ARCHITECTURE, artifact: { ...CONFORMING_ARCHITECTURE.artifact, openQuestions: [] } };
}

/** CONFORMING_ARCHITECTURE with its behaviorContract emptied out, diverging from its constraints. */
function buildArchitectureMissingContractLines(): EpicArchitecture {
  return { ...CONFORMING_ARCHITECTURE, artifact: { ...CONFORMING_ARCHITECTURE.artifact, behaviorContract: [] } };
}

function checkById(verdict: DesignCriticVerdict, id: string): RubricCheck {
  const check = verdict.checks.find((c) => c.id === id);
  if (check === undefined) {
    throw new Error(`no check with id ${id}`);
  }
  return check;
}

describe('critiqueEpicDesignAgainstAdrs', () => {
  it('rework: the gherkin scenario — a design that drops active ADR-0004 as a constraint', () => {
    const broken = buildArchitectureMissingAdr();

    const verdict = critiqueEpicDesignAgainstAdrs(broken, APPROVED_DOC, [ADR_0004]);

    expect(verdict.verdict).toBe('rework');
    expect(verdict.violatedAdrs).toEqual(['ADR-0004']);
    expect(checkById(verdict, 'adrs-honored').passed).toBe(false);
    expect(checkById(verdict, 'adrs-honored').note).toContain('ADR-0004');
  });

  it('rework: a constraint citing a retired/unknown ADR label', () => {
    const broken = buildArchitectureWithStaleCitation();

    const verdict = critiqueEpicDesignAgainstAdrs(broken, APPROVED_DOC, [ADR_0004]);

    expect(verdict.verdict).toBe('rework');
    expect(verdict.violatedAdrs).toEqual(['ADR-9999']);
    expect(checkById(verdict, 'adr-citations-active').passed).toBe(false);
    expect(checkById(verdict, 'adr-citations-active').note).toContain('ADR-9999');
  });

  it('pass: a conforming architecture yields an empty violatedAdrs list and a full rationale', () => {
    const verdict = critiqueEpicDesignAgainstAdrs(CONFORMING_ARCHITECTURE, APPROVED_DOC, [ADR_0004]);

    expect(verdict.verdict).toBe('pass');
    expect(verdict.violatedAdrs).toEqual([]);
    expect(verdict.rationale).toBe('All 6 checks passed.');
    expect(verdict.checks.every((c) => c.passed)).toBe(true);
  });

  it('rework: unapproved doc, undisclosed deviation, divergent contract, and empty verification plan each fail their own check', () => {
    const artifact = DesignArtifactSchema.parse({
      restatedProblem: 'p',
      approach: { chosen: 'c', rejected: [] },
      interfacesTouched: [],
      targetTypes: [],
      signatures: [],
      callGraph: [],
      behaviorContract: [],
      verificationPlan: [],
      riskBlastRadius: 'r',
      openQuestions: [],
    });
    const broken: EpicArchitecture = {
      artifact,
      constraints: [
        { text: 'ADR-0004 — Narrow public core API: Only export the narrow API from core.', adr: 'ADR-0004' },
      ],
      deviations: [{ subject: 'x', text: 'introduce a new component for story "X"' }],
    };

    const verdict = critiqueEpicDesignAgainstAdrs(broken, DRAFT_DOC, [ADR_0004]);

    expect(verdict.verdict).toBe('rework');
    expect(checkById(verdict, 'intent-approved').passed).toBe(false);
    expect(checkById(verdict, 'deviations-disclosed').passed).toBe(false);
    expect(checkById(verdict, 'contract-mirrors-constraints').passed).toBe(false);
    expect(checkById(verdict, 'verification-grounded').passed).toBe(false);
    expect(checkById(verdict, 'adrs-honored').passed).toBe(true);
    expect(checkById(verdict, 'adr-citations-active').passed).toBe(true);
  });
});

describe('reworkEpicArchitectureMechanically', () => {
  it('adds the missing ADR constraint and re-critiquing the result yields pass, without mutating the input', () => {
    const broken = buildArchitectureMissingAdr();
    const originalLength = broken.constraints.length;
    const verdict = critiqueEpicDesignAgainstAdrs(broken, APPROVED_DOC, [ADR_0004]);

    const reworked = reworkEpicArchitectureMechanically(broken, verdict, APPROVED_DOC, [ADR_0004]);

    expect(reworked.constraints.some((c) => c.adr === 'ADR-0004')).toBe(true);
    expect(broken.constraints.length).toBe(originalLength);

    const reCritiqued = critiqueEpicDesignAgainstAdrs(reworked, APPROVED_DOC, [ADR_0004]);
    expect(reCritiqued.verdict).toBe('pass');
  });

  it('drops a stale ADR citation and records the constraint as a disclosed deviation', () => {
    const broken = buildArchitectureWithStaleCitation();
    const verdict = critiqueEpicDesignAgainstAdrs(broken, APPROVED_DOC, [ADR_0004]);
    const staleConstraint = broken.constraints.find((c) => c.adr === 'ADR-9999');
    if (staleConstraint === undefined) {
      throw new Error('fixture missing a stale constraint');
    }

    const reworked = reworkEpicArchitectureMechanically(broken, verdict, APPROVED_DOC, [ADR_0004]);

    expect(reworked.constraints.some((c) => c.text === staleConstraint.text && c.adr === undefined)).toBe(true);
    expect(reworked.deviations).toContainEqual({ subject: 'adr-9999', text: staleConstraint.text });
    expect(reworked.artifact.openQuestions).toContain(`needs a new ADR: ${staleConstraint.text}`);
  });

  it('returns the input unchanged when nothing failed is mechanically fixable', () => {
    const verdict = critiqueEpicDesignAgainstAdrs(CONFORMING_ARCHITECTURE, DRAFT_DOC, [ADR_0004]);
    expect(checkById(verdict, 'intent-approved').passed).toBe(false);
    expect(verdict.checks.filter((c) => !c.passed)).toHaveLength(1);

    const reworked = reworkEpicArchitectureMechanically(CONFORMING_ARCHITECTURE, verdict, DRAFT_DOC, [ADR_0004]);

    expect(reworked).toBe(CONFORMING_ARCHITECTURE);
  });

  it('returns the input unchanged when the verdict already passes', () => {
    const verdict = critiqueEpicDesignAgainstAdrs(CONFORMING_ARCHITECTURE, APPROVED_DOC, [ADR_0004]);
    expect(verdict.verdict).toBe('pass');

    const reworked = reworkEpicArchitectureMechanically(CONFORMING_ARCHITECTURE, verdict, APPROVED_DOC, [ADR_0004]);

    expect(reworked).toBe(CONFORMING_ARCHITECTURE);
  });

  it('does not duplicate an open question when multiple stale constraints share the same text', () => {
    const broken: EpicArchitecture = {
      ...CONFORMING_ARCHITECTURE,
      constraints: [
        ...CONFORMING_ARCHITECTURE.constraints,
        { text: 'duplicate stale text', adr: 'ADR-9999' },
        { text: 'duplicate stale text', adr: 'ADR-8888' },
      ],
    };
    const verdict = critiqueEpicDesignAgainstAdrs(broken, APPROVED_DOC, [ADR_0004]);
    expect(checkById(verdict, 'adr-citations-active').passed).toBe(false);

    const reworked = reworkEpicArchitectureMechanically(broken, verdict, APPROVED_DOC, [ADR_0004]);

    const matchingOpenQuestions = reworked.artifact.openQuestions.filter(
      (q) => q === 'needs a new ADR: duplicate stale text',
    );
    expect(matchingOpenQuestions).toHaveLength(1);
  });

  it('discloses a missing deviation as an open question and re-critiquing yields pass', () => {
    const broken = buildArchitectureMissingOpenQuestion();
    const verdict = critiqueEpicDesignAgainstAdrs(broken, APPROVED_DOC, [ADR_0004]);
    expect(checkById(verdict, 'deviations-disclosed').passed).toBe(false);

    const reworked = reworkEpicArchitectureMechanically(broken, verdict, APPROVED_DOC, [ADR_0004]);

    expect(reworked.artifact.openQuestions).toEqual(
      CONFORMING_ARCHITECTURE.deviations.map((d) => `needs a new ADR: ${d.text}`),
    );
    const reCritiqued = critiqueEpicDesignAgainstAdrs(reworked, APPROVED_DOC, [ADR_0004]);
    expect(reCritiqued.verdict).toBe('pass');
  });

  it('rebuilds the behavior contract from the constraints and re-critiquing yields pass', () => {
    const broken = buildArchitectureMissingContractLines();
    const verdict = critiqueEpicDesignAgainstAdrs(broken, APPROVED_DOC, [ADR_0004]);
    expect(checkById(verdict, 'contract-mirrors-constraints').passed).toBe(false);

    const reworked = reworkEpicArchitectureMechanically(broken, verdict, APPROVED_DOC, [ADR_0004]);

    expect(reworked.artifact.behaviorContract).toEqual(broken.constraints.map((c) => c.text));
    const reCritiqued = critiqueEpicDesignAgainstAdrs(reworked, APPROVED_DOC, [ADR_0004]);
    expect(reCritiqued.verdict).toBe('pass');
  });
});

describe('critiqueEpicDesign', () => {
  it('reworks a fixable violation to pass in one bounded iteration, with a strictly decreasing failed-check history', async () => {
    const broken = buildArchitectureMissingAdr();

    const result = await critiqueEpicDesign(broken, APPROVED_DOC, [ADR_0004]);

    expect(result.stopReason).toBe('passed');
    expect(result.iterations).toBe(1);
    expect(result.failedCheckHistory).toEqual([1, 0]);
    expect(result.verdict.verdict).toBe('pass');
  });

  it('passes immediately for an already-conforming design, without reworking', async () => {
    const result = await critiqueEpicDesign(CONFORMING_ARCHITECTURE, APPROVED_DOC, [ADR_0004]);

    expect(result.stopReason).toBe('passed');
    expect(result.iterations).toBe(0);
    expect(result.failedCheckHistory).toEqual([0]);
  });

  it('stops at no-improvement when the only failing check is not mechanically fixable', async () => {
    const result = await critiqueEpicDesign(CONFORMING_ARCHITECTURE, DRAFT_DOC, [ADR_0004]);

    expect(result.stopReason).toBe('no-improvement');
    expect(result.iterations).toBe(1);
    expect(result.failedCheckHistory).toEqual([1, 1]);
  });

  it('is structurally bounded — an adversarial critic/reworker that never reaches pass still stops at maxIterations', async () => {
    function checksWithFailedCount(failCount: number): RubricCheck[] {
      return Array.from({ length: 5 }, (_, idx) => ({
        id: `check-${idx}`,
        label: `check ${idx}`,
        passed: idx >= failCount,
        note: idx >= failCount ? 'passing' : 'failing',
      }));
    }

    function failCountQueueCritic(counts: readonly number[]) {
      let i = 0;
      return vi.fn(async (): Promise<DesignCriticVerdict> => {
        const failCount = counts[Math.min(i, counts.length - 1)]!;
        i += 1;
        return {
          verdict: failCount === 0 ? 'pass' : 'rework',
          violatedAdrs: [],
          rationale: failCount === 0 ? 'All 5 checks passed.' : 'still failing',
          checks: checksWithFailedCount(failCount),
        };
      });
    }

    const critic = failCountQueueCritic([4, 3, 2, 1]);
    const rework = vi.fn(async (architecture: EpicArchitecture) => architecture);

    const result = await critiqueEpicDesign(
      CONFORMING_ARCHITECTURE,
      APPROVED_DOC,
      [ADR_0004],
      { critic, rework },
      { maxIterations: 3 },
    );

    expect(result.stopReason).toBe('max-iterations');
    expect(result.iterations).toBe(3);
    expect(result.failedCheckHistory).toEqual([4, 3, 2, 1]);
  });

  it('rejects a negative or non-integer maxIterations, and returns immediately at max-iterations for 0', async () => {
    await expect(
      critiqueEpicDesign(CONFORMING_ARCHITECTURE, APPROVED_DOC, [ADR_0004], {}, { maxIterations: -1 }),
    ).rejects.toThrow('design critic: maxIterations must be a non-negative integer');
    await expect(
      critiqueEpicDesign(CONFORMING_ARCHITECTURE, APPROVED_DOC, [ADR_0004], {}, { maxIterations: 1.5 }),
    ).rejects.toThrow('design critic: maxIterations must be a non-negative integer');

    const broken = buildArchitectureMissingAdr();
    const result = await critiqueEpicDesign(broken, APPROVED_DOC, [ADR_0004], {}, { maxIterations: 0 });

    expect(result.stopReason).toBe('max-iterations');
    expect(result.iterations).toBe(0);
  });
});
