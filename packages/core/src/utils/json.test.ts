import { describe, expect, it } from 'vitest';
import { extractJsonObjects } from './json.js';

describe('extractJsonObjects', () => {
  it('extracts a single plain object and returns both text and parsed value', () => {
    const candidates = extractJsonObjects('{"a":1}');

    expect(candidates).toHaveLength(1);
    expect(candidates[0].text).toBe('{"a":1}');
    expect(candidates[0].value).toEqual({ a: 1 });
  });

  it('handles braces and escaped quotes inside string values', () => {
    const candidates = extractJsonObjects('{"a":"x { \\" } y"}');

    expect(candidates).toHaveLength(1);
    expect(candidates[0].value).toEqual({ a: 'x { " } y' });
  });

  it('returns multiple top-level objects in order without re-reporting nested objects', () => {
    const candidates = extractJsonObjects('{"a":1} then {"b":{"c":2}}');

    expect(candidates).toHaveLength(2);
    expect(candidates[0].value).toEqual({ a: 1 });
    expect(candidates[1].value).toEqual({ b: { c: 2 } });
  });

  it('skips unparseable balanced candidates and still finds a later valid object', () => {
    const candidates = extractJsonObjects('{oops}\n{"ok":1}');

    expect(candidates).toHaveLength(1);
    expect(candidates[0].value).toEqual({ ok: 1 });
  });

  it('recovers a nested valid object when the outer candidate is invalid JSON', () => {
    const candidates = extractJsonObjects('{oops {"ok":1} more}');

    expect(candidates).toHaveLength(1);
    expect(candidates[0].value).toEqual({ ok: 1 });
  });

  it('returns [] for prose with no braces', () => {
    expect(extractJsonObjects('no json here')).toEqual([]);
  });

  it('returns [] for a truncated object', () => {
    expect(extractJsonObjects('{"a":')).toEqual([]);
  });

  it('ignores braces in surrounding non-JSON text', () => {
    const candidates = extractJsonObjects('function f() { return { a: 1 }; }\n{"ok":true}');

    expect(candidates).toHaveLength(1);
    expect(candidates[0].value).toEqual({ ok: true });
  });
});
