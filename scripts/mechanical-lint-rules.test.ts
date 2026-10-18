import { describe, expect, it } from 'vitest';

import config from '../oxlint.config.js';

const MECHANICAL_RULES = [
  'prefer-const',
  'no-useless-concat',
  'typescript/no-unnecessary-template-expression',
  'unicorn/no-lonely-if',
  'unicorn/prefer-logical-operator-over-ternary',
] as const;

describe('mechanical lint rules (#3202)', () => {
  it.each(MECHANICAL_RULES)('keeps %s at error', (rule) => {
    expect(config.rules?.[rule]).toBe('error');
  });
});
