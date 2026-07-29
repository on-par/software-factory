// packages/product/src/readiness/report.ts — proposer readiness scorer (#475).

import type { ProposerArtifacts } from './artifacts.js';

export type ReadinessStatus = 'ready' | 'not-ready';

export type ReadinessDimensionId =
  'intent' | 'decomposition' | 'technical-design' | 'design-critique' | 'adr-conformance';

export interface ReadinessDimension {
  id: ReadinessDimensionId;
  label: string;
  ready: boolean;
  /** Non-empty. Why it is (not) ready, naming the missing/failed artifact. */
  reason: string;
}

/** A question the proposer hands downstream instead of blocking on. */
export interface OpenQuestion {
  text: string;
  /** Always the downstream writer in this slice. */
  forOwner: 'writer';
  source: 'epic-architecture' | 'adr-conformance';
}

export interface ReadinessReport {
  status: ReadinessStatus;
  /** Always exactly five, in the fixed order of READINESS_DIMENSION_IDS. */
  dimensions: readonly ReadinessDimension[];
  /** Open questions never affect status — they are the writer's inbox, not blockers. */
  openQuestions: readonly OpenQuestion[];
}

export const READINESS_DIMENSION_IDS: readonly ReadinessDimensionId[] = [
  'intent',
  'decomposition',
  'technical-design',
  'design-critique',
  'adr-conformance',
];

function assessIntent(artifacts: ProposerArtifacts): ReadinessDimension {
  const { intent } = artifacts;
  if (!intent) {
    return { id: 'intent', label: 'Intent', ready: false, reason: 'intent doc missing' };
  }
  if (intent.status !== 'approved') {
    return {
      id: 'intent',
      label: 'Intent',
      ready: false,
      reason: 'intent doc is a draft — human gate #1 (approveIntentDoc) has not passed',
    };
  }
  return { id: 'intent', label: 'Intent', ready: true, reason: 'intent doc is approved' };
}

function assessDecomposition(artifacts: ProposerArtifacts): ReadinessDimension {
  const { decomposition } = artifacts;
  if (!decomposition) {
    return { id: 'decomposition', label: 'Decomposition', ready: false, reason: 'decomposition missing' };
  }
  if (decomposition.stories.length === 0) {
    return { id: 'decomposition', label: 'Decomposition', ready: false, reason: 'decomposition has no stories' };
  }
  return {
    id: 'decomposition',
    label: 'Decomposition',
    ready: true,
    reason: `decomposition has ${decomposition.stories.length} stor${decomposition.stories.length === 1 ? 'y' : 'ies'}`,
  };
}

function assessTechnicalDesign(artifacts: ProposerArtifacts): ReadinessDimension {
  const { epicArchitecture } = artifacts;
  if (!epicArchitecture) {
    return {
      id: 'technical-design',
      label: 'Technical design',
      ready: false,
      reason: 'missing the epic architecture document',
    };
  }
  return {
    id: 'technical-design',
    label: 'Technical design',
    ready: true,
    reason: 'epic architecture document is present',
  };
}

function assessDesignCritique(artifacts: ProposerArtifacts): ReadinessDimension {
  const { designCritique } = artifacts;
  if (!designCritique) {
    return {
      id: 'design-critique',
      label: 'Design critique',
      ready: false,
      reason: 'epic-design critic result missing',
    };
  }
  if (!designCritique.allPassed) {
    const notPassed = designCritique.stories.filter((s) => s.stopReason !== 'passed').length;
    return {
      id: 'design-critique',
      label: 'Design critique',
      ready: false,
      reason: `${notPassed} of ${designCritique.stories.length} stories did not pass the epic-design critic`,
    };
  }
  return {
    id: 'design-critique',
    label: 'Design critique',
    ready: true,
    reason: 'all stories passed the epic-design critic',
  };
}

function isBlank(text: string): boolean {
  return text.trim() === '';
}

function assessAdrConformance(artifacts: ProposerArtifacts): ReadinessDimension {
  const { adrConformance } = artifacts;
  if (!adrConformance) {
    return {
      id: 'adr-conformance',
      label: 'ADR conformance',
      ready: false,
      reason: 'ADR conformance evidence missing',
    };
  }
  const nonConforming = adrConformance.drafts
    .map((draft, i) => ({ draft, ordinal: i + 1 }))
    .filter(({ draft }) => isBlank(draft.title) || isBlank(draft.context) || isBlank(draft.decision));
  if (nonConforming.length > 0) {
    const names = nonConforming.map(({ draft, ordinal }) => (isBlank(draft.title) ? `draft #${ordinal}` : draft.title));
    return {
      id: 'adr-conformance',
      label: 'ADR conformance',
      ready: false,
      reason: `non-conforming ADR drafts: ${names.join(', ')}`,
    };
  }
  return {
    id: 'adr-conformance',
    label: 'ADR conformance',
    ready: true,
    reason: `${adrConformance.drafts.length} ADR draft(s) conform`,
  };
}

function collectOpenQuestions(artifacts: ProposerArtifacts): OpenQuestion[] {
  const questions: OpenQuestion[] = [];

  for (const text of artifacts.epicArchitecture?.openQuestions ?? []) {
    if (!isBlank(text)) {
      questions.push({ text, forOwner: 'writer', source: 'epic-architecture' });
    }
  }

  for (const text of artifacts.adrConformance?.unrecordedDecisions ?? []) {
    if (!isBlank(text)) {
      questions.push({
        text: `unrecorded architecture decision: ${text}`,
        forOwner: 'writer',
        source: 'adr-conformance',
      });
    }
  }

  return questions;
}

/** Pure and deterministic: same ProposerArtifacts in, byte-identical ReadinessReport out. */
export function assessReadiness(artifacts: ProposerArtifacts): ReadinessReport {
  const dimensions: readonly ReadinessDimension[] = [
    assessIntent(artifacts),
    assessDecomposition(artifacts),
    assessTechnicalDesign(artifacts),
    assessDesignCritique(artifacts),
    assessAdrConformance(artifacts),
  ];

  return {
    status: dimensions.every((d) => d.ready) ? 'ready' : 'not-ready',
    dimensions,
    openQuestions: collectOpenQuestions(artifacts),
  };
}
