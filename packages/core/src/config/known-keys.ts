// packages/core/src/config/known-keys.ts — derive a known-key tree from a zod schema (#3568), so the unknown-key
// warning has one source of truth.
import { ANY_CONFIG_KEY, type KnownConfigKeys } from '@on-par/factory-config';
import { z } from 'zod';

/** `true` when the schema accepts any value at this position or already fails loudly on unknown keys (strict
 *  and loose objects carry a catchall); otherwise a map of known keys to their subtrees. */
export function knownConfigKeysFromSchema(schema: z.core.$ZodType): KnownConfigKeys | true {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault || schema instanceof z.ZodNullable) {
    return knownConfigKeysFromSchema(schema.def.innerType);
  }
  if (schema instanceof z.ZodCatch) return knownConfigKeysFromSchema(schema.def.innerType);
  if (schema instanceof z.ZodPipe) return knownConfigKeysFromSchema(schema.def.in);
  if (schema instanceof z.ZodRecord) return { [ANY_CONFIG_KEY]: knownConfigKeysFromSchema(schema.def.valueType) };
  if (schema instanceof z.ZodObject) {
    if (schema.def.catchall) return true;
    const tree: Record<string, KnownConfigKeys | true> = {};
    for (const [key, value] of Object.entries(schema.def['shape'])) tree[key] = knownConfigKeysFromSchema(value);
    return tree;
  }
  return true;
}
