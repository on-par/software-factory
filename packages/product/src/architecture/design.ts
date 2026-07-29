// packages/product/src/architecture/design.ts — the pure epic-level architecture designer (#477).
import type { DesignArtifact } from '@on-par/contracts';
import { DesignArtifactSchema } from '@on-par/contracts';

import type { Decomposition } from '../decompose/index.js';
import type { IntentDoc } from '../intent/index.js';
import type { EpicAdr } from './adrs.js';
import type { RepoComponent, RepoSurvey } from './survey.js';

/** An epic-level decision the designer made; `subject` is the lower-cased term ADR backing is checked against. */
export interface ArchitectureDecision {
  subject: string;
  text: string;
}

/** A constraint in the epic architecture. Backed constraints carry the ADR label; unbacked ones need a new ADR. */
export interface ArchitectureConstraint {
  text: string;
  adr?: string;
}

export interface EpicArchitecture {
  /** Schema-valid shared artifact — drops straight into ProposerArtifacts.epicArchitecture. */
  artifact: DesignArtifact;
  /** Active-ADR constraints first (one per ADR), then decision constraints, in derivation order. */
  constraints: readonly ArchitectureConstraint[];
  /** Decisions no active ADR covers — each also appears in artifact.openQuestions as 'needs a new ADR: …'. */
  deviations: readonly ArchitectureDecision[];
}

export type EpicArchitectureResult =
  { ok: true; architecture: EpicArchitecture } | { ok: false; blockers: readonly string[] };

function condense(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

function storyText(story: Decomposition['stories'][number]): string {
  return [story.title, story.want, ...story.inScope].join(' ').toLowerCase();
}

function findBackingAdr(subject: string, adrs: readonly EpicAdr[]): EpicAdr | undefined {
  return adrs.find((adr) => `${adr.title} ${adr.decision}`.toLowerCase().includes(subject));
}

export function designEpicArchitecture(
  decomposition: Decomposition,
  doc: IntentDoc,
  context: { adrs: readonly EpicAdr[]; survey: RepoSurvey },
): EpicArchitectureResult {
  const blockers: string[] = [];

  if (doc.status !== 'approved') {
    blockers.push('the epic designer needs an approved intent doc (human gate #1)');
  }
  if (decomposition.stories.length === 0) {
    blockers.push('the epic designer needs at least one story to bound');
  }
  if (blockers.length > 0) {
    return { ok: false, blockers };
  }

  const { epic, stories } = decomposition;
  const { adrs, survey } = context;

  const texts = stories.map(storyText);
  const touched: RepoComponent[] = survey.components.filter((component) =>
    texts.some((text) => text.includes(component.name.toLowerCase())),
  );

  const decisions: ArchitectureDecision[] = [];
  for (const component of touched) {
    decisions.push({
      subject: component.name.toLowerCase(),
      text: `change component ${component.name} (${component.path})`,
    });
  }
  stories.forEach((story, i) => {
    const text = texts[i]!;
    const mentionsComponent = survey.components.some((component) => text.includes(component.name.toLowerCase()));
    if (!mentionsComponent) {
      decisions.push({
        subject: story.title.toLowerCase(),
        text: `introduce a new component for story "${story.title}"`,
      });
    }
  });

  const deviations: ArchitectureDecision[] = [];
  const decisionConstraints: ArchitectureConstraint[] = [];
  for (const decision of decisions) {
    const backingAdr = findBackingAdr(decision.subject, adrs);
    if (backingAdr) {
      decisionConstraints.push({ text: `${decision.text} (per ${backingAdr.label})`, adr: backingAdr.label });
    } else {
      decisionConstraints.push({ text: decision.text });
      deviations.push(decision);
    }
  }

  const adrConstraints: ArchitectureConstraint[] = adrs.map((adr) => ({
    text: `${adr.label} — ${adr.title}: ${condense(adr.decision, 300)}`,
    adr: adr.label,
  }));

  const constraints: ArchitectureConstraint[] = [...adrConstraints, ...decisionConstraints];

  const verificationPlan: DesignArtifact['verificationPlan'] = [];
  const seenCommands = new Set<string>();
  for (const story of stories) {
    for (const step of story.verification) {
      if (seenCommands.has(step.command)) {
        continue;
      }
      seenCommands.add(step.command);
      verificationPlan.push(step);
    }
  }

  const approachChosen =
    `Deliver epic "${epic.title}" as ${stories.length} vertical slice(s)` +
    (touched.length > 0 ? `, touching ${touched.map((c) => c.name).join(', ')}` : ', introducing new component(s)') +
    (survey.hasAdrHome ? `, bounded by ${adrs.length} active ADR(s)` : ', with no ADR home found in the target repo');

  const artifact: DesignArtifact = DesignArtifactSchema.parse({
    restatedProblem: epic.why,
    approach: { chosen: approachChosen, rejected: [] },
    interfacesTouched: touched.map((c) => c.path),
    targetTypes: [],
    signatures: [],
    callGraph: [],
    behaviorContract: constraints.map((c) => c.text),
    verificationPlan,
    riskBlastRadius: `Epic-level architecture bounds every story in "${epic.title}"; a wrong sketch misleads all ${stories.length} story(ies) and any ADR drafts derived from it.`,
    openQuestions: deviations.map((d) => `needs a new ADR: ${d.text}`),
  });

  return { ok: true, architecture: { artifact, constraints, deviations } };
}
