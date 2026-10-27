import { describe, expect, it } from 'vitest';
import { PrConfigSections } from './pr-section.js';

it('keeps the PR section and footer optional', () => {
  expect(PrConfigSections.pr.parse(undefined)).toBeUndefined();
  expect(PrConfigSections.pr.parse({})).toEqual({});
});

describe('PR section validation', () => {
  it('rejects unknown keys and a non-object section', () => {
    expect(PrConfigSections.pr.safeParse({ other: 'x' }).success).toBe(false);
    expect(PrConfigSections.pr.safeParse('footer').success).toBe(false);
  });
});

describe('pr.walkthrough (#3623)', () => {
  it('accepts partial non-negative integer thresholds', () => {
    expect(PrConfigSections.pr.parse({ walkthrough: { minLines: 100 } })).toEqual({ walkthrough: { minLines: 100 } });
    expect(PrConfigSections.pr.safeParse({ walkthrough: { minLines: 0, minFiles: 0 } }).success).toBe(true);
  });

  it('rejects negative, fractional and unknown keys', () => {
    expect(PrConfigSections.pr.safeParse({ walkthrough: { minLines: -1 } }).success).toBe(false);
    expect(PrConfigSections.pr.safeParse({ walkthrough: { minFiles: 1.5 } }).success).toBe(false);
    expect(PrConfigSections.pr.safeParse({ walkthrough: { other: 1 } }).success).toBe(false);
  });
});

describe('pr.evidenceComment', () => {
  it('accepts a boolean and rejects anything else', () => {
    expect(PrConfigSections.pr.parse({ evidenceComment: true })).toEqual({ evidenceComment: true });
    expect(PrConfigSections.pr.safeParse({ evidenceComment: 'yes' }).success).toBe(false);
  });
});
