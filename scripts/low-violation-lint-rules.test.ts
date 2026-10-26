import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import config from '../oxlint.config.js';

const KEPT_RULES = [
  'prefer-const',
  'typescript/no-unnecessary-template-expression',
  'typescript/no-unnecessary-boolean-literal-compare',
  'no-useless-concat',
  'unicorn/no-lonely-if',
  'unicorn/prefer-logical-operator-over-ternary',
  'unicorn/prefer-set-has',
  'unicorn/prefer-array-find',
  'typescript/return-await',
  'typescript/switch-exhaustiveness-check',
  'preserve-caught-error',
  'typescript/no-deprecated',
  'typescript/no-misused-promises',
  'no-param-reassign',
  'typescript/no-invalid-void-type',
] as const;

const DROPPED_RULES = [
  'typescript/prefer-promise-reject-errors',
  'typescript/no-dynamic-delete',
  'no-useless-assignment',
] as const;

const commentLines = readFileSync(new URL('../oxlint.config.ts', import.meta.url), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('//'));

describe('low-violation lint rules (#2764)', () => {
  it.each(KEPT_RULES)('keeps %s at error', (rule) => {
    expect(config.rules?.[rule]).toBe('error');
  });

  it('keeps eqeqeq at error and ignores null comparisons', () => {
    expect(config.rules?.eqeqeq).toEqual(['error', 'always', { null: 'ignore' }]);
  });

  it.each(DROPPED_RULES)('does not enable %s', (rule) => {
    expect(config.rules?.[rule]).toBeUndefined();
  });

  it.each(DROPPED_RULES)('documents why %s stays off', (rule) => {
    expect(commentLines.some((line) => line.includes(`${rule} stays off`))).toBe(true);
  });
});
