import { isAbsolute } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  constitutionsDir,
  defaultFactoryConfig,
  defaultModelsConfig,
  defaultRoutesConfig,
  resolveConfigPath,
} from './index.js';

describe('config paths', () => {
  it('resolves shared config paths', () => {
    const constitutionsPath = resolveConfigPath('constitutions');

    expect(isAbsolute(constitutionsPath)).toBe(true);
    expect(constitutionsPath.endsWith('constitutions')).toBe(true);
    expect(constitutionsDir.endsWith('constitutions')).toBe(true);
  });

  it('re-exports the shipped defaults from the package root', () => {
    expect(defaultModelsConfig).toBeDefined();
    expect(defaultRoutesConfig).toBeDefined();
    expect(defaultFactoryConfig).toBeDefined();
  });
});
