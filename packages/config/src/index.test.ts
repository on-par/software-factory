import { isAbsolute } from 'node:path';

import { describe, expect, it } from 'vitest';

import { constitutionsDir, resolveConfigPath } from './index.js';

describe('config paths', () => {
  it('resolves shared config paths', () => {
    const modelsPath = resolveConfigPath('models.json');

    expect(isAbsolute(modelsPath)).toBe(true);
    expect(modelsPath.endsWith('models.json')).toBe(true);
    expect(constitutionsDir.endsWith('constitutions')).toBe(true);
  });
});
