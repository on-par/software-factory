import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FactoryConfigSchema } from './index.js';
import { FACTORY_RUNTIME_CONFIG_KEYS } from './runtime-config-keys.js';

// A missing entry silently drops that runtime section from repo overlays.
describe('runtime config ownership', () => {
  it('registers every runtime section, including pr, while leaving version to routing', () => {
    const properties = z.toJSONSchema(FactoryConfigSchema).properties ?? {};
    const schemaKeys = Object.keys(properties).filter((key) => key !== 'version');
    expect([...FACTORY_RUNTIME_CONFIG_KEYS].sort()).toEqual(schemaKeys.sort());
    expect(new Set(FACTORY_RUNTIME_CONFIG_KEYS).size).toBe(FACTORY_RUNTIME_CONFIG_KEYS.length);
  });
});
