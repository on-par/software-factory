import { ANY_CONFIG_KEY } from '@on-par/factory-config';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { knownConfigKeysFromSchema } from './known-keys.js';

describe('knownConfigKeysFromSchema (#3568)', () => {
  it('maps a scalar to a leaf', () => {
    expect(knownConfigKeysFromSchema(z.string())).toBe(true);
  });

  it('maps a nested object to a key map', () => {
    expect(knownConfigKeysFromSchema(z.object({ a: z.number(), b: z.object({ c: z.string() }) }))).toEqual({
      a: true,
      b: { c: true },
    });
  });

  it('unwraps default, optional, nullable and catch', () => {
    const inner = z.object({ a: z.number() });
    expect(knownConfigKeysFromSchema(inner.default({ a: 1 }))).toEqual({ a: true });
    expect(knownConfigKeysFromSchema(inner.optional())).toEqual({ a: true });
    expect(knownConfigKeysFromSchema(inner.nullable())).toEqual({ a: true });
    expect(knownConfigKeysFromSchema(inner.catch({ a: 1 }))).toEqual({ a: true });
  });

  it('follows the input side of a pipe', () => {
    expect(knownConfigKeysFromSchema(z.object({ a: z.number() }).pipe(z.any()))).toEqual({ a: true });
  });

  it('maps a record to the wildcard key', () => {
    expect(knownConfigKeysFromSchema(z.record(z.string(), z.object({ u: z.string() })))).toEqual({
      [ANY_CONFIG_KEY]: { u: true },
    });
  });

  it('maps strict and loose objects to a leaf', () => {
    expect(knownConfigKeysFromSchema(z.object({ a: z.number() }).strict())).toBe(true);
    expect(knownConfigKeysFromSchema(z.looseObject({ a: z.number() }))).toBe(true);
  });
});
