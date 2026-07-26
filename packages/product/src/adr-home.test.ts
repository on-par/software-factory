// packages/product/src/adr-home.test.ts (#469).

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ADR_CONVENTION, ADR_HOME_DIR, listAdrFilenames, nextAdrFilename, resolveAdrHome } from './adr-home.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');

describe('adr-home', () => {
  it('declares docs/adr as the shared ADR home', () => {
    expect(ADR_HOME_DIR).toBe('docs/adr');
    expect(ADR_CONVENTION.numberWidth).toBe(4);
  });

  it('resolves the ADR home against a repo root', () => {
    expect(resolveAdrHome('/repo')).toBe(resolve('/repo', 'docs/adr'));
  });

  it('numbers the first ADR as 0001', () => {
    expect(nextAdrFilename([], 'First Decision')).toBe('0001-first-decision.md');
  });

  it('numbers by max existing number, not by count', () => {
    expect(nextAdrFilename(['0001-a.md', '0004-d.md'], 'Next Thing')).toBe('0005-next-thing.md');
  });

  it('filters out README.md and non-markdown files', () => {
    const result = listAdrFilenames('/x', () => ['README.md', '0001-a.md', 'notes.txt', '0002-b.md']);
    expect(result).toEqual(['0001-a.md', '0002-b.md']);
  });

  it('reads the real repo docs/adr/ with the default readDir', () => {
    const result = listAdrFilenames(resolveAdrHome(REPO_ROOT));
    expect(result).toContain('0001-boss-worker-checker-pipeline.md');
    expect(result).not.toContain('README.md');
  });
});
