import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { loadFactoryConfig, loadFactoryConfigForRepo, resolveSizeGateBudget, resolveSizeGateMode } from './index.js';

describe('sizeGate.tokenBudget / maxFiles (#3350)', () => {
  it.each(['Off', 'none', 'bogus'])('warns once and falls back to stack for unknown mode %j', (mode) => {
    const config = { ...loadFactoryConfig(), sizeGate: { mode } };
    const warnings: string[] = [];

    expect(resolveSizeGateMode(config, (line) => warnings.push(line))).toBe('stack');
    expect(resolveSizeGateMode(config, (line) => warnings.push(line))).toBe('stack');
    expect(warnings).toEqual([`factory: unknown size gate mode '${mode}' runs as stack; allowed values: off, stack`]);
  });

  it('resolveSizeGateBudget reads tokenBudget and maxFiles and falls back to defaults', () => {
    const base = loadFactoryConfig();
    expect(
      resolveSizeGateBudget({ ...base, sizeGate: { mode: 'file', maxSlices: 10, tokenBudget: 90000, maxFiles: 7 } }),
    ).toEqual({ tokenBudget: 90000, maxFiles: 7 });
    expect(resolveSizeGateBudget({ ...base, sizeGate: { mode: 'file' } })).toEqual({
      tokenBudget: 150000,
      maxFiles: 12,
    });
    expect(resolveSizeGateBudget({ ...base, sizeGate: { mode: 'file', maxFiles: 5 } })).toEqual({
      tokenBudget: 150000,
      maxFiles: 5,
    });
  });

  it.each([
    ['tokenBudget', 0],
    ['maxFiles', -1],
    ['maxFiles', 2.5],
  ])('fails config load for %s %j', async (key, value) => {
    const tempDirs = createTempDirs();
    const dir = await tempDirs.make('factory-config-');
    try {
      const path = join(dir, 'factory.json');
      await writeFile(path, JSON.stringify({ sizeGate: { mode: 'file', [key]: value } }));
      expect(() => loadFactoryConfigForRepo(path)).toThrow(new RegExp(`sizeGate\\.${key}`));
    } finally {
      await tempDirs.cleanup();
    }
  });
});
