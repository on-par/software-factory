import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import config, { MAX_LINES_BASELINE } from '../oxlint.config.js';
import {
  grownBaselineMessage,
  MAX_LINES_DOCS,
  MAX_LINES_LIMIT,
  oversizedFileMessage,
  staleBaselineEntries,
} from './max-lines-baseline.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const LINTABLE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const IGNORED_PREFIXES = ['coverage/', '.factory/', 'tools/oxlint/anti-slop/'];

function lineCount(path: string): number {
  const lines = readFileSync(resolve(REPO_ROOT, path), 'utf8').split('\n');
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

const countExisting = (path: string) => (existsSync(resolve(REPO_ROOT, path)) ? lineCount(path) : undefined);

describe('max-lines lint guard (#2776, #2777, #2778)', () => {
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
      expect(lineCount(path), grownBaselineMessage(path, lineCount(path), recorded)).toBeLessThanOrEqual(recorded);
    }
  });

  it('flags a baseline entry whose file shrank to 500 lines or fewer, naming the file and asking for its removal', () => {
    const baseline = { 'a.ts': 900, 'b.ts': 700 };
    const counts: Record<string, number> = { 'a.ts': MAX_LINES_LIMIT, 'b.ts': 650 };
    const messages = staleBaselineEntries(baseline, (path) => counts[path]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('a.ts');
    expect(messages[0]).toContain('500 lines');
    expect(messages[0]).toContain('remove it from max-lines-baseline.json');
    expect(staleBaselineEntries({ 'a.ts': 900 }, () => 499)).toHaveLength(1);
    expect(staleBaselineEntries({ 'a.ts': 900 }, () => 501)).toEqual([]);
  });

  it('flags a baseline entry whose file no longer exists', () => {
    expect(staleBaselineEntries({ 'gone.ts': 900 }, () => undefined)).toEqual([
      `gone.ts no longer exists; remove it from max-lines-baseline.json; see ${MAX_LINES_DOCS}`,
    ]);
  });

  it('passes once the stale entry is removed from the baseline', () => {
    const counts: Record<string, number> = { 'b.ts': 650 };
    expect(staleBaselineEntries({ 'b.ts': 700 }, (path) => counts[path])).toEqual([]);
  });

  it('keeps no baseline entry for a file that is missing or 500 lines or fewer', () => {
    expect(staleBaselineEntries(MAX_LINES_BASELINE, countExisting)).toEqual([]);
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
      expect(Object.keys(MAX_LINES_BASELINE), oversizedFileMessage(path, lineCount(path))).toContain(path);
    }
  });

  it('points every max-lines failure message to the docs', () => {
    const oversized = oversizedFileMessage('a.ts', 501);
    const grown = grownBaselineMessage('a.ts', 901, 900);
    const [shrunk] = staleBaselineEntries({ 'a.ts': 900 }, () => 400);
    const [missing] = staleBaselineEntries({ 'a.ts': 900 }, () => undefined);
    for (const message of [oversized, grown, shrunk, missing]) {
      expect(message).toContain(MAX_LINES_DOCS);
    }
    expect(oversized).toContain('split');
    expect(grown).toContain('900');
    expect(shrunk).toContain('remove it from max-lines-baseline.json');
    expect(missing).toContain('remove it from max-lines-baseline.json');
  });

  it('documents the limit, the baseline format and the fix for each failure in the verify skill', () => {
    const [docPath, anchor] = MAX_LINES_DOCS.split('#');
    const doc = readFileSync(resolve(REPO_ROOT, docPath ?? ''), 'utf8');
    expect(doc).toContain('## Max-lines guard');
    expect(anchor).toBe('max-lines-guard');
    expect(doc).toContain('500');
    expect(doc).toContain('max-lines-baseline.json');
    expect(doc).toContain('oxlint.config.ts');
    expect(doc).toContain('### New file over 500 lines');
    expect(doc).toContain('### Baseline file grew');
    expect(doc).toContain('### Baseline file shrank or was deleted');
  });

  it('documents the human override under the max-lines guard (#3466)', () => {
    const doc = readFileSync(resolve(REPO_ROOT, '.claude/skills/verify/SKILL.md'), 'utf8');
    const start = doc.indexOf('## Max-lines guard');
    const end = doc.indexOf('\n## ', start + 1);
    const section = doc.slice(start, end);
    expect(section).toContain('### Human override');
    expect(section.slice(section.indexOf('### Human override'))).toContain('max-lines:override');
  });
});
