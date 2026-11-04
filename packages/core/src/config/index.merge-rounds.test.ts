import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadFactoryConfigForRepo } from './index.js';

describe('merge.maxConflictRounds (#1887)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'factory-merge-rounds-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults merge.maxConflictRounds to 2 when the config has no merge section', () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ version: 2 }));
    expect(loadFactoryConfigForRepo(path).merge.maxConflictRounds).toBe(2);
  });

  it('accepts an override within 1-10', () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ merge: { maxConflictRounds: 5 } }));
    expect(loadFactoryConfigForRepo(path).merge.maxConflictRounds).toBe(5);
  });

  it('rejects maxConflictRounds of 0', () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ merge: { maxConflictRounds: 0 } }));
    expect(() => loadFactoryConfigForRepo(path)).toThrow(/maxConflictRounds/);
  });
});
