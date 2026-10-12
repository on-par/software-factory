import { describe, expect, it } from 'vitest';

import { STANDARD_CHECKER_NAMES } from './index.js';
import { findUnknownConstitutionCheckers, formatUnknownCheckerMessage } from './constitution-preflight.js';

const fixture = '---\nproduct: acme\nversion: 1\ncheckers:\n  - <checker-name>\n  - compile\n---\nbody';

describe('findUnknownConstitutionCheckers', () => {
  it('accepts built-ins, custom_*, and empty lists', () => {
    expect(findUnknownConstitutionCheckers([...STANDARD_CHECKER_NAMES, 'custom_foo', 'custom_'])).toEqual([]);
    expect(findUnknownConstitutionCheckers([])).toEqual([]);
  });

  it('reports the 1-based line of a placeholder', () => {
    expect(findUnknownConstitutionCheckers(['<checker-name>', 'compile'], fixture)).toEqual([
      { name: '<checker-name>', line: 5 },
    ]);
  });

  it('reports an inline flow list on the checkers: line', () => {
    const raw = '---\ncheckers: [compile, typecheck]\n---\n';
    expect(findUnknownConstitutionCheckers(['compile', 'typecheck'], raw)).toEqual([{ name: 'typecheck', line: 2 }]);
  });

  it('matches quoted items and strips trailing comments', () => {
    const raw = "---\ncheckers:\n  # note\n  - 'typecheck' # why\n---\n";
    expect(findUnknownConstitutionCheckers(['typecheck'], raw)).toEqual([{ name: 'typecheck', line: 4 }]);
  });

  it('gives duplicates distinct lines', () => {
    const raw = '---\ncheckers:\n  - typecheck\n  - typecheck\n---\n';
    expect(findUnknownConstitutionCheckers(['typecheck', 'typecheck'], raw)).toEqual([
      { name: 'typecheck', line: 3 },
      { name: 'typecheck', line: 4 },
    ]);
  });

  it('omits the line without raw text or when not found', () => {
    expect(findUnknownConstitutionCheckers(['typecheck'])).toEqual([{ name: 'typecheck' }]);
    expect(findUnknownConstitutionCheckers(['typecheck'], 'no frontmatter')).toEqual([{ name: 'typecheck' }]);
  });

  it('reports non-string entries via String()', () => {
    expect(findUnknownConstitutionCheckers([42, null, {}])).toEqual([
      { name: '42' },
      { name: 'null' },
      { name: '[object Object]' },
    ]);
  });
});

describe('formatUnknownCheckerMessage', () => {
  const allowed = 'worker_output, compile, tests, lint, links, accessibility, design_smells, custom_*';
  it('formats with and without a line', () => {
    expect(formatUnknownCheckerMessage('.factory/constitution.md', { name: 'typecheck', line: 5 })).toBe(
      `.factory/constitution.md:5: unknown checker 'typecheck'. Remove the line or use one of: ${allowed}`,
    );
    expect(formatUnknownCheckerMessage('.factory/constitution.md', { name: 'typecheck' })).toBe(
      `.factory/constitution.md: unknown checker 'typecheck'. Remove the line or use one of: ${allowed}`,
    );
  });
});
