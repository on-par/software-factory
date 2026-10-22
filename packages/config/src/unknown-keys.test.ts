import { describe, expect, it } from 'vitest';
import { ANY_CONFIG_KEY, findUnknownConfigKeys, type KnownConfigKeys } from './unknown-keys.js';

describe('findUnknownConfigKeys (#3568)', () => {
  const tree: KnownConfigKeys = { sandbox: { writablePaths: true, enabled: true } };

  it('an unknown nested key is reported by its dotted path', () => {
    expect(findUnknownConfigKeys({ sandbox: { foo: 1, writablePaths: [] } }, tree)).toEqual(['sandbox.foo']);
  });

  it('returns nothing for a non-object raw', () => {
    expect(findUnknownConfigKeys(null, tree)).toEqual([]);
    expect(findUnknownConfigKeys([1], tree)).toEqual([]);
    expect(findUnknownConfigKeys('x', tree)).toEqual([]);
  });

  it('accepts any key under the wildcard and walks the nested values', () => {
    const t: KnownConfigKeys = { notifications: { [ANY_CONFIG_KEY]: { url: true } } };
    expect(findUnknownConfigKeys({ notifications: { a: { url: 'x' }, b: { bad: 1 } } }, t)).toEqual([
      'notifications.b.bad',
    ]);
  });

  it('does not walk into a leaf with an object value', () => {
    expect(findUnknownConfigKeys({ sandbox: { writablePaths: { any: 1 } } }, tree)).toEqual([]);
  });

  it('reports a top-level unknown key and sorts the output', () => {
    expect(findUnknownConfigKeys({ zed: 1, sandbox: { b: 1, a: 1 } }, tree)).toEqual(['sandbox.a', 'sandbox.b', 'zed']);
  });
});
