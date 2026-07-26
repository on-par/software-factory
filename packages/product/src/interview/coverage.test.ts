// packages/product/src/interview/coverage.test.ts (#470).

import { describe, expect, it } from 'vitest';

import { detectCoverage, isSubstantiveAnswer } from './coverage.js';
import { DIMENSION_PROBES } from './dimensions.js';

describe('detectCoverage', () => {
  it('returns an empty list for an empty dump', () => {
    expect(detectCoverage('')).toEqual([]);
  });

  it.each(DIMENSION_PROBES.map((probe) => [probe.dimension, probe.cues[0]] as const))(
    'includes %s when the dump contains its first cue',
    (dimension, cue) => {
      expect(detectCoverage(`Some text mentioning ${cue} in context.`)).toContain(dimension);
    },
  );

  it('matches case-insensitively', () => {
    expect(detectCoverage('The DEADLINE is Q3')).toContain('constraints');
  });

  it('returns results in canonical order for a dump hitting several dimensions', () => {
    const dump = 'This is a constraint about deadline, but also a problem, and as a user I really care.';
    expect(detectCoverage(dump)).toEqual(['problem', 'audience', 'constraints']);
  });
});

describe('isSubstantiveAnswer', () => {
  it.each([
    ['Engineers on the platform team', true],
    ['', false],
    ['   ', false],
    ['no', false],
    ["I don't know", false],
    ['dunno', false],
    ['not sure', false],
    ['n/a', false],
    ['N/A', false],
    ['tbd', false],
    ['skip', false],
    ['no idea', false],
    ['TBD-ish, but probably Q3', false],
  ])('isSubstantiveAnswer(%j) === %s', (answer, expected) => {
    expect(isSubstantiveAnswer(answer)).toBe(expected);
  });
});
