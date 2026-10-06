import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { STEWARD_VERDICT_CATEGORIES, StewardVerdictSchema, applyEscalation, parseStewardVerdict } from './diagnose.js';

function validVerdict(): Record<string, unknown> {
  return {
    diagnosis: 'The checker fails because the fixture is stale.',
    category: 'test',
    nextStep: '  Regenerate the fixture and rerun.  ',
    confidence: 0.95,
    citations: [{ field: 'logs', excerpt: 'expected 1 received 2' }],
  };
}

describe('parseStewardVerdict', () => {
  it('does not escalate a confident verdict and preserves nextStep', () => {
    const input = validVerdict();
    const out = parseStewardVerdict(input);
    expect(out.escalate).toBe(false);
    expect(out.nextStep).toBe('  Regenerate the fixture and rerun.  ');
    expect(out.category).toBe('test');
  });

  it.each([0.9, 1])('does not escalate at confidence %s', (confidence) => {
    expect(parseStewardVerdict({ ...validVerdict(), confidence }).escalate).toBe(false);
  });

  it.each([0.89, 0])('escalates at confidence %s without changing nextStep', (confidence) => {
    const out = parseStewardVerdict({ ...validVerdict(), confidence });
    expect(out.escalate).toBe(true);
    expect(out.nextStep).toBe('  Regenerate the fixture and rerun.  ');
  });

  it.each(STEWARD_VERDICT_CATEGORIES)('accepts category %s', (category) => {
    expect(parseStewardVerdict({ ...validVerdict(), category }).category).toBe(category);
  });

  const cite = { field: 'logs', excerpt: 'x' };
  const without = (key: string) => {
    const v = validVerdict();
    delete v[key];
    return v;
  };
  const cases: [string, unknown][] = [
    ['missing diagnosis', without('diagnosis')],
    ['missing category', without('category')],
    ['missing nextStep', without('nextStep')],
    ['missing confidence', without('confidence')],
    ['missing citations', without('citations')],
    ['extra key', { ...validVerdict(), action: 'merge' }],
    ['category infra', { ...validVerdict(), category: 'infra' }],
    ['empty category', { ...validVerdict(), category: '' }],
    ['confidence -0.1', { ...validVerdict(), confidence: -0.1 }],
    ['confidence 1.1', { ...validVerdict(), confidence: 1.1 }],
    ['confidence NaN', { ...validVerdict(), confidence: NaN }],
    ['confidence Infinity', { ...validVerdict(), confidence: Infinity }],
    ['confidence string', { ...validVerdict(), confidence: '0.95' }],
    ['empty diagnosis', { ...validVerdict(), diagnosis: '' }],
    ['whitespace nextStep', { ...validVerdict(), nextStep: '   ' }],
    ['empty citations', { ...validVerdict(), citations: [] }],
    ['11 citations', { ...validVerdict(), citations: Array.from({ length: 11 }, () => cite) }],
    ['bad citation field', { ...validVerdict(), citations: [{ field: 'secrets', excerpt: 'x' }] }],
    ['empty excerpt', { ...validVerdict(), citations: [{ field: 'logs', excerpt: '' }] }],
    ['501-char excerpt', { ...validVerdict(), citations: [{ field: 'logs', excerpt: 'a'.repeat(501) }] }],
    ['citation extra key', { ...validVerdict(), citations: [{ ...cite, line: 3 }] }],
    ['2001-char diagnosis', { ...validVerdict(), diagnosis: 'a'.repeat(2001) }],
    ['null', null],
    ['string input', 'not a verdict'],
  ];

  it.each(cases)('rejects %s', (_name, raw) => {
    expect(() => StewardVerdictSchema.parse(raw)).toThrow(ZodError);
    expect(() => parseStewardVerdict(raw)).toThrow(ZodError);
  });
});

describe('applyEscalation', () => {
  it('does not mutate its input', () => {
    const input = StewardVerdictSchema.parse(validVerdict());
    const out = applyEscalation(input);
    expect(out).not.toBe(input);
    expect('escalate' in input).toBe(false);
  });
});
