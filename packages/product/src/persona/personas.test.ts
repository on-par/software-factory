// packages/product/src/persona/personas.test.ts (#473).

import { describe, expect, it } from 'vitest';

import { PERSONA_IDS } from './findings.js';
import { PERSONA_PROBES, probeForPersona } from './personas.js';

describe('PERSONA_PROBES', () => {
  it('covers exactly PERSONA_IDS, in the same order', () => {
    expect(PERSONA_PROBES.map((p) => p.persona)).toEqual(PERSONA_IDS);
  });

  it('gives every probe at least one rule and a non-empty label and concern', () => {
    for (const probe of PERSONA_PROBES) {
      expect(probe.rules.length).toBeGreaterThan(0);
      expect(probe.label.trim().length).toBeGreaterThan(0);
      expect(probe.concern.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('probeForPersona', () => {
  it('is total over PERSONA_IDS', () => {
    for (const persona of PERSONA_IDS) {
      expect(probeForPersona(persona).persona).toBe(persona);
    }
  });
});
