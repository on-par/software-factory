import { describe, expect, it } from 'vitest';
import { slugify, shellEscape, branchFor } from './index.js';

describe('utils', () => {
  it('slugifies text for branch-safe identifiers', () => {
    expect(slugify('Hello, World! 123')).toBe('hello-world-123');
    expect(slugify('  --Trim--  ')).toBe('trim');
    expect(slugify('a very long title that should be truncated by slugify').length).toBeLessThanOrEqual(32);
  });

  it('escapes strings for single-quoted shell arguments', () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
    expect(shellEscape('plain')).toBe("'plain'");
  });

  it('builds a ship-it branch from issue and title, matching slugify', () => {
    expect(branchFor(22, 'Reliably detect a merged PR')).toBe(`ship-it/22-${slugify('Reliably detect a merged PR')}`);
    expect(branchFor(7, 'Hello, World!')).toBe('ship-it/7-hello-world');
  });
});
