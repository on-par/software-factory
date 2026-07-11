import { describe, expect, it } from 'vitest';
import { slugify, shellEscape } from './index.js';

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
});
