import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import config from '../oxlint.config.js';

const ENABLED = ['typescript/no-misused-spread', 'typescript/require-array-sort-compare'] as const;

const KEPT = [
  'typescript/no-base-to-string',
  'typescript/unbound-method',
  'unicorn/no-thenable',
  'typescript/prefer-promise-reject-errors',
  'typescript/no-dynamic-delete',
  'no-useless-assignment',
] as const;

const pkg: { scripts: Record<string, string> } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const configLines = readFileSync(new URL('../oxlint.config.ts', import.meta.url), 'utf8').split('\n');

function trackedSources(): string[] {
  return execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.mts', '*.js', '*.mjs'], { encoding: 'utf8' })
    .split('\n')
    .filter(
      (file) => file !== '' && !file.startsWith('tools/oxlint/anti-slop/') && !file.includes('ci-suppression-guard'),
    );
}

describe('lint override audit (#4056)', () => {
  it('fails lint on unused disable directives', () => {
    expect(pkg.scripts.lint).toContain('--report-unused-disable-directives-severity=error');
  });

  it('has no disable directive naming an unrun rule namespace', () => {
    const pattern = /\/[/*]\s*(eslint|oxlint)-disable[^\n]*(@typescript-eslint\/|security\/)/;
    const offenders = trackedSources().filter((file) =>
      readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
        .split('\n')
        .some((line) => pattern.test(line)),
    );
    expect(offenders).toEqual([]);
  });

  it.each(ENABLED)('enables audited rule %s at error', (rule) => {
    expect(config.rules?.[rule]).toBe('error');
  });

  it.each(KEPT)('documents kept override %s with a one-line reason and follow-up issue', (rule) => {
    const index = configLines.findIndex((line) => line.trim().startsWith('//') && line.includes(rule));
    expect(index).toBeGreaterThanOrEqual(0);
    const note = configLines[index].trim();
    const issues = note.match(/#\d{4,}/g) ?? [];
    expect(issues.filter((issue) => issue !== '#2846').length).toBeGreaterThan(0);
    expect(note.endsWith('.')).toBe(true);
  });
});
