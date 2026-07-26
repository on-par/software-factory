// packages/product/src/persona/panel.ts — run the five persona lenses over a decomposition (#473).

import type { Decomposition } from '../decompose/index.js';
import type { IntentDoc } from '../intent/index.js';
import type { PersonaFinding, PersonaId } from './findings.js';
import { PERSONA_IDS } from './findings.js';
import { PERSONA_PROBES } from './personas.js';

export interface PersonaPanelReport {
  /** Findings in story order, then canonical persona order, then rule order. */
  findings: readonly PersonaFinding[];
  /** Personas that surfaced at least one finding, in canonical order. */
  personas: readonly PersonaId[];
  /** True when no persona surfaced anything. */
  clean: boolean;
}

/** Interrogate a decomposition as eng/customer/support/security/ops. Pure and deterministic. */
export function runPersonaPanel(decomposition: Decomposition, doc: IntentDoc): PersonaPanelReport {
  const findings: PersonaFinding[] = [];
  for (const story of decomposition.stories) {
    for (const probe of PERSONA_PROBES) {
      for (const rule of probe.rules) {
        const finding = rule({ decomposition, doc, story });
        if (finding !== undefined) {
          findings.push(finding);
        }
      }
    }
  }
  const found = new Set(findings.map((f) => f.persona));
  return { findings, personas: PERSONA_IDS.filter((id) => found.has(id)), clean: findings.length === 0 };
}
