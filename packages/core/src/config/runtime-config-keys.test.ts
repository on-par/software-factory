import { describe, expect, it } from 'vitest';

import { FACTORY_RUNTIME_CONFIG_KEYS, FactoryConfigSchema } from './index.js';

describe('FACTORY_RUNTIME_CONFIG_KEYS', () => {
  it('equals FactoryConfigSchema top-level keys minus version', () => {
    const schemaKeys = FactoryConfigSchema.keyof().options.filter((k) => k !== 'version');
    expect([...FACTORY_RUNTIME_CONFIG_KEYS].sort()).toEqual([...schemaKeys].sort());
  });
});
