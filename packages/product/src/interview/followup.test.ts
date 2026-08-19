// packages/product/src/interview/followup.test.ts (#632).

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FOLLOW_UP_BUDGET,
  FOLLOW_UP_ANGLES,
  MAX_FOLLOW_UP_DEPTH,
  followUpAngle,
  isUsableFollowUp,
} from './followup.js';

describe('followUpAngle', () => {
  it('returns distinct non-empty angles for rungs 1 and 2', () => {
    const first = followUpAngle(1);
    const second = followUpAngle(2);
    expect(first).not.toBe('');
    expect(second).not.toBe('');
    expect(first).not.toBe(second);
  });

  it('clamps a depth of 0 or negative up to the first angle', () => {
    expect(followUpAngle(0)).toBe(FOLLOW_UP_ANGLES[0]);
    expect(followUpAngle(-1)).toBe(FOLLOW_UP_ANGLES[0]);
  });

  it('truncates a fractional depth', () => {
    expect(followUpAngle(2.7)).toBe(FOLLOW_UP_ANGLES[1]);
  });

  it('clamps a depth past the list down to the last angle', () => {
    expect(followUpAngle(99)).toBe(FOLLOW_UP_ANGLES[FOLLOW_UP_ANGLES.length - 1]);
  });
});

describe('FOLLOW_UP_ANGLES / MAX_FOLLOW_UP_DEPTH / DEFAULT_FOLLOW_UP_BUDGET', () => {
  it('has exactly MAX_FOLLOW_UP_DEPTH angles', () => {
    expect(FOLLOW_UP_ANGLES.length).toBe(MAX_FOLLOW_UP_DEPTH);
  });

  it('DEFAULT_FOLLOW_UP_BUDGET is a positive integer', () => {
    expect(Number.isInteger(DEFAULT_FOLLOW_UP_BUDGET)).toBe(true);
    expect(DEFAULT_FOLLOW_UP_BUDGET).toBeGreaterThan(0);
  });
});

describe('isUsableFollowUp', () => {
  it('rejects undefined', () => {
    expect(isUsableFollowUp(undefined, [])).toBe(false);
  });

  it('rejects blank/whitespace-only text', () => {
    expect(isUsableFollowUp('', [])).toBe(false);
    expect(isUsableFollowUp('   ', [])).toBe(false);
  });

  it('accepts a fresh question', () => {
    expect(isUsableFollowUp('Why does that matter?', ['What is broken today?'])).toBe(true);
  });

  it('rejects a repeat differing only by case', () => {
    expect(isUsableFollowUp('WHY DOES THAT MATTER?', ['Why does that matter?'])).toBe(false);
  });

  it('rejects a repeat differing only by trailing punctuation', () => {
    expect(isUsableFollowUp('Why does that matter', ['Why does that matter?'])).toBe(false);
  });

  it('rejects a repeat differing only by collapsed whitespace', () => {
    expect(isUsableFollowUp('Why   does that   matter?', ['Why does that matter?'])).toBe(false);
  });
});
