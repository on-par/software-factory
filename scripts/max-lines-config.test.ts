import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import config, { MAX_LINES_BASELINE } from '../oxlint.config.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const LINTABLE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const IGNORED_PREFIXES = ['coverage/', '.factory/', 'tools/oxlint/anti-slop/'];

function lineCount(path: string): number {
  const lines = readFileSync(resolve(REPO_ROOT, path), 'utf8').split('\n');
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

describe('max-lines lint guard (#2776, #2777)', () => {
  it('limits every file to 500 lines, counting blank lines and comments', () => {
    expect(config.rules?.['max-lines']).toEqual(['error', { max: 500, skipBlankLines: false, skipComments: false }]);
  });

  it('caps each baseline file at its recorded line count', () => {
    expect(config.overrides).toEqual(
      Object.entries(MAX_LINES_BASELINE).map(([file, max]) => ({
        files: [file],
        rules: { 'max-lines': ['error', { max, skipBlankLines: false, skipComments: false }] },
      })),
    );
    for (const override of config.overrides ?? []) {
      expect(override.rules?.['max-lines']).not.toBe('off');
    }
  });

  it('records only existing files with counts over the limit that have not grown', () => {
    for (const [path, recorded] of Object.entries(MAX_LINES_BASELINE)) {
      expect(existsSync(resolve(REPO_ROOT, path)), `${path} exists`).toBe(true);
      expect(recorded, `${path} recorded count`).toBeGreaterThan(500);
      expect(lineCount(path), `${path} line count`).toBeLessThanOrEqual(recorded);
    }
  });

  it('records every lintable file over 500 lines in the baseline', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n');
    const oversized = tracked.filter(
      (path) =>
        LINTABLE.test(path) &&
        !path.includes('/dist/') &&
        !IGNORED_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
        existsSync(resolve(REPO_ROOT, path)) &&
        lineCount(path) > 500,
    );
    for (const path of oversized) {
      expect(Object.keys(MAX_LINES_BASELINE), `${path} is baselined`).toContain(path);
    }
  });
});
