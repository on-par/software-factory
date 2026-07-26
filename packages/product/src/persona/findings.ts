// packages/product/src/persona/findings.ts — what a persona finding is (#473).

import type { AcceptanceCriterion, IntentStatementId, Story } from '@on-par/contracts';

import type { Decomposition } from '../decompose/index.js';
import type { IntentDoc } from '../intent/index.js';

export type PersonaId = 'eng' | 'customer' | 'support' | 'security' | 'ops';

/** Canonical order: findings are always reported in this persona order. */
export const PERSONA_IDS: readonly PersonaId[] = ['eng', 'customer', 'support', 'security', 'ops'];

export type FindingKind = 'gap' | 'risk' | 'assumption' | 'dependency';

/** Exactly one actionable ask per finding — ask the PM, or propose the criterion. */
export type PersonaAction = { kind: 'question'; text: string } | { kind: 'criterion'; criterion: AcceptanceCriterion };

export interface PersonaFinding {
  persona: PersonaId;
  kind: FindingKind;
  /** Title of the story this finding lands on. */
  subject: string;
  /** What the persona noticed, in that persona's voice. */
  observation: string;
  action: PersonaAction;
  /** Intent statement IDs behind the story this finding interrogates. */
  tracesTo: readonly IntentStatementId[];
}

/** Everything a rule may read. Rules are pure functions of this. */
export interface PanelContext {
  decomposition: Decomposition;
  doc: IntentDoc;
  story: Story;
}

/** A rule returns a finding when its concern is unaddressed, otherwise undefined. */
export type PersonaRule = (ctx: PanelContext) => PersonaFinding | undefined;

export function askQuestion(
  persona: PersonaId,
  kind: FindingKind,
  story: Story,
  observation: string,
  text: string,
): PersonaFinding {
  return {
    persona,
    kind,
    subject: story.title,
    observation,
    action: { kind: 'question', text },
    tracesTo: story.tracesTo,
  };
}

export function proposeCriterion(
  persona: PersonaId,
  kind: FindingKind,
  story: Story,
  observation: string,
  criterion: Omit<AcceptanceCriterion, 'tracesTo'>,
): PersonaFinding {
  return {
    persona,
    kind,
    subject: story.title,
    observation,
    action: { kind: 'criterion', criterion: { ...criterion, tracesTo: story.tracesTo } },
    tracesTo: story.tracesTo,
  };
}
