// packages/core/src/config/unknown-runtime-keys.ts — nested runtime-config keys the schema silently strips (#3568).
import { findUnknownConfigKeys } from '@on-par/factory-config';
import { FACTORY_RUNTIME_CONFIG_KEYS, FactoryConfigSchema } from './index.js';
import { knownConfigKeysFromSchema } from './known-keys.js';

let knownRuntimeKeys: ReturnType<typeof knownConfigKeysFromSchema> | undefined;

/** Dotted paths of nested keys under the runtime-policy sections that FactoryConfigSchema silently strips.
 *  Top-level keys outside FACTORY_RUNTIME_CONFIG_KEYS belong to the strict routing schema; strict and loose
 *  sections (`run.*`) are not walked. Sorted. Pure. */
export function unknownRuntimeConfigKeys(raw: Record<string, unknown>): string[] {
  knownRuntimeKeys ??= knownConfigKeysFromSchema(FactoryConfigSchema);
  if (knownRuntimeKeys === true) return [];
  const picked: Record<string, unknown> = {};
  for (const key of FACTORY_RUNTIME_CONFIG_KEYS) {
    if (key in raw) picked[key] = raw[key];
  }
  return findUnknownConfigKeys(picked, knownRuntimeKeys);
}
