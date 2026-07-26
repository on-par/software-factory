// packages/product/src/persona/personas.ts — the declarative persona probe table (#473).

import type { PersonaId, PersonaRule } from './findings.js';
import {
  customerAdoptionRule,
  customerMeasurableValueRule,
  engAutomatedVerificationRule,
  engRepoContextRule,
  opsObservabilityRule,
  opsRollbackRule,
  securityAbuseCaseRule,
  securityAuthorizationRule,
  supportFailurePathRule,
  supportRunbookRule,
} from './rules.js';

export interface PersonaProbe {
  persona: PersonaId;
  /** Human label used in the rendered panel. */
  label: string;
  /** One line: what this persona interrogates for. */
  concern: string;
  rules: readonly PersonaRule[];
}

export const PERSONA_PROBES: readonly PersonaProbe[] = [
  {
    persona: 'eng',
    label: 'Engineering',
    concern: 'Can this be built and verified as written — what is unknown, coupled, or unsized?',
    rules: [engRepoContextRule, engAutomatedVerificationRule],
  },
  {
    persona: 'customer',
    label: 'Customer',
    concern: 'Would the person with the problem notice, find, and value this?',
    rules: [customerMeasurableValueRule, customerAdoptionRule],
  },
  {
    persona: 'support',
    label: 'Support',
    concern: 'What happens when it breaks, and what does the agent on the ticket read?',
    rules: [supportFailurePathRule, supportRunbookRule],
  },
  {
    persona: 'security',
    label: 'Security',
    concern: 'Who is allowed to do this, what data moves, and what must be refused?',
    rules: [securityAuthorizationRule, securityAbuseCaseRule],
  },
  {
    persona: 'ops',
    label: 'Operations',
    concern: 'How does this roll out, get watched, and get turned off?',
    rules: [opsRollbackRule, opsObservabilityRule],
  },
];

const BY_PERSONA = new Map(PERSONA_PROBES.map((p) => [p.persona, p]));

/** The probe for a persona. Total over PersonaId — the map is built from the same list. */
export function probeForPersona(persona: PersonaId): PersonaProbe {
  return BY_PERSONA.get(persona)!;
}
