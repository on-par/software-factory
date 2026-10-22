import { describe, expect, it } from 'vitest';
import { unknownRuntimeConfigKeys } from './unknown-runtime-keys.js';

describe('unknownRuntimeConfigKeys (#3568)', () => {
  it('reports an unknown nested key by its dotted path', () => {
    expect(unknownRuntimeConfigKeys({ sandbox: { foo: 1, writablePaths: [] } })).toEqual(['sandbox.foo']);
  });

  it('returns nothing for known keys, record sections, strict sections and non-runtime keys', () => {
    expect(unknownRuntimeConfigKeys({ sandbox: { writablePaths: [] } })).toEqual([]);
    expect(unknownRuntimeConfigKeys({ notifications: { x: true } })).toEqual([]);
    expect(unknownRuntimeConfigKeys({ run: { merge: { bogus: 1 } } })).toEqual([]);
    expect(unknownRuntimeConfigKeys({ models: { bogus: 1 }, whatever: 1 })).toEqual([]);
  });
});
