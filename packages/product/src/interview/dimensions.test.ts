// packages/product/src/interview/dimensions.test.ts (#470).

import { describe, expect, it } from 'vitest';

import { DIMENSION_PROBES, INTENT_DIMENSIONS, probeFor } from './dimensions.js';

const EXPECTED_ORDER = ['problem', 'audience', 'outcome', 'scope', 'nonGoals', 'constraints'];

describe('DIMENSION_PROBES', () => {
  it('has exactly 6 entries in the canonical ask order', () => {
    expect(DIMENSION_PROBES).toHaveLength(6);
    expect(DIMENSION_PROBES.map((p) => p.dimension)).toEqual(EXPECTED_ORDER);
  });

  it('matches INTENT_DIMENSIONS to the same order', () => {
    expect(INTENT_DIMENSIONS).toEqual(EXPECTED_ORDER);
  });

  it('gives every probe a non-empty label, a question ending in ?, and lowercase cues', () => {
    for (const probe of DIMENSION_PROBES) {
      expect(probe.label.length).toBeGreaterThan(0);
      expect(probe.question.endsWith('?')).toBe(true);
      expect(probe.cues.length).toBeGreaterThan(0);
      for (const cue of probe.cues) {
        expect(cue).toBe(cue.toLowerCase());
      }
    }
  });
});

describe('probeFor', () => {
  it.each(INTENT_DIMENSIONS)('returns the probe whose dimension is %s', (dimension) => {
    expect(probeFor(dimension).dimension).toBe(dimension);
  });
});
