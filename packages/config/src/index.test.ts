import { isAbsolute } from 'node:path';

import { describe, expect, it } from 'vitest';

import { constitutionsDir, resolveConfigPath } from './index.js';

describe('config paths', () => {
  it('resolves shared config paths', () => {
    const constitutionsPath = resolveConfigPath('constitutions');

    expect(isAbsolute(constitutionsPath)).toBe(true);
    expect(constitutionsPath.endsWith('constitutions')).toBe(true);
    expect(constitutionsDir.endsWith('constitutions')).toBe(true);
  });
});
