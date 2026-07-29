// packages/product/src/readiness/artifacts.ts — proposer/writer artifact classifier + input set (#475).

import type { AdrDraft, DesignArtifact } from '@on-par/contracts';

import type { Decomposition } from '../decompose/index.js';
import type { IntentDoc } from '../intent/index.js';
import type { JudgeReport } from '../judge/index.js';

/** Who must produce an artifact before it can gate anything. */
export type ArtifactOwner = 'proposer' | 'writer';

/** Artifacts the proposer owns — each maps 1:1 to a readiness dimension. */
export type ProposerArtifactKind =
  'intent' | 'decomposition' | 'epic-architecture' | 'design-critique' | 'adr-conformance';

/** Downstream artifacts the writer owns — never readiness prerequisites. */
export type WriterArtifactKind = 'story-program-design' | 'implementation-plan' | 'code-change';

export type ArtifactKind = ProposerArtifactKind | WriterArtifactKind;

export const PROPOSER_ARTIFACT_KINDS: readonly ProposerArtifactKind[] = [
  'intent',
  'decomposition',
  'epic-architecture',
  'design-critique',
  'adr-conformance',
];

export const WRITER_ARTIFACT_KINDS: readonly WriterArtifactKind[] = [
  'story-program-design',
  'implementation-plan',
  'code-change',
];

/** The one classifier the gate trusts: proposer-owned kinds gate handoff, writer-owned never do. */
export function classifyArtifact(kind: ArtifactKind): ArtifactOwner {
  return (PROPOSER_ARTIFACT_KINDS as readonly string[]).includes(kind) ? 'proposer' : 'writer';
}

/** ADR conformance evidence the proposer collected against the ADR home. */
export interface AdrConformanceEvidence {
  /** Decisions the proposer recorded as drafts for the factory's ADR writer. */
  drafts: readonly AdrDraft[];
  /** Decisions the proposer knows are NOT yet recorded — handed downstream as open questions. */
  unrecordedDecisions: readonly string[];
}

/** The complete proposer-owned artifact set. Absent field = artifact was never produced. */
export interface ProposerArtifacts {
  intent?: IntentDoc;
  decomposition?: Decomposition;
  /** Epic-level architecture document — the shared DesignArtifact shape from @on-par/contracts. */
  epicArchitecture?: DesignArtifact;
  /** Result of the epic-design critic loop (#474). */
  designCritique?: JudgeReport;
  adrConformance?: AdrConformanceEvidence;
}
