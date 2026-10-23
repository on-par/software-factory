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
