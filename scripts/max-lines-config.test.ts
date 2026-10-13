import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import config, { OVERSIZED_FILES_PENDING_BASELINE } from '../oxlint.config.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');

function lineCount(path: string): number {
  const lines = readFileSync(resolve(REPO_ROOT, path), 'utf8').split('\n');
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

describe('max-lines lint guard (#2776)', () => {
  it('limits every file to 500 lines, counting blank lines and comments', () => {
    expect(config.rules?.['max-lines']).toEqual(['error', { max: 500, skipBlankLines: false, skipComments: false }]);
  });

  it('excludes only the pending-baseline files from max-lines', () => {
    expect(config.overrides).toEqual([{ files: [...OVERSIZED_FILES_PENDING_BASELINE], rules: { 'max-lines': 'off' } }]);
  });

  it('lists only files that exist and are over the limit', () => {
    for (const path of OVERSIZED_FILES_PENDING_BASELINE) {
      expect(existsSync(resolve(REPO_ROOT, path)), `${path} exists`).toBe(true);
      expect(lineCount(path), `${path} line count`).toBeGreaterThan(500);
    }
  });
});
