import { describe, expect, it, vi } from 'vitest';

import { AcceptanceCriterionSchema } from './gherkin.js';
import { deserialize, serialize, tryDeserialize } from './serde.js';

describe('serialize', () => {
  it('throws on an invalid value', () => {
    const invalid = { name: '', given: [], when: [], then: [] };
    expect(() => serialize(AcceptanceCriterionSchema, invalid as never)).toThrow();
  });
});

describe('deserialize', () => {
  it('throws on invalid JSON', () => {
    expect(() => deserialize(AcceptanceCriterionSchema, '{ not valid json')).toThrow();
  });

  it('throws on well-formed JSON that fails the schema', () => {
    expect(() => deserialize(AcceptanceCriterionSchema, JSON.stringify({ name: 'x' }))).toThrow();
  });
});

describe('tryDeserialize', () => {
  it('returns ok: true with the parsed value on success', () => {
    const fixture = { name: 'Sign in', given: [], when: ['a click'], then: ['a redirect'] };
    const result = tryDeserialize(AcceptanceCriterionSchema, JSON.stringify(fixture));
    expect(result).toEqual({ ok: true, value: fixture });
  });

  it('returns ok: false with a json-prefixed error on malformed JSON', () => {
    const result = tryDeserialize(AcceptanceCriterionSchema, '{ not valid json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/^json: /);
    }
  });

  it('stringifies a non-Error thrown while parsing', () => {
    const parseSpy = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw 'boom';
    });
    const result = tryDeserialize(AcceptanceCriterionSchema, 'irrelevant');
    parseSpy.mockRestore();
    expect(result).toEqual({ ok: false, errors: ['json: boom'] });
  });

  it('returns ok: false with path-prefixed errors on a schema violation', () => {
    const result = tryDeserialize(AcceptanceCriterionSchema, JSON.stringify({ given: [], when: [], then: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('name:'))).toBe(true);
    }
  });
});
