import { describe, expect, it } from 'vitest';
import { validateQueue } from './index.js';

describe('validateQueue', () => {
  it('accepts a valid queue', () => {
    const result = validateQueue('app 5\napp 6\ninfra 7\n');
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([5, 6, 7]);
    expect(result.errors).toEqual([]);
  });

  it('allows comments and a trailing blank line', () => {
    const result = validateQueue('# plan\napp 5\n# skip 9: vague\napp 6\n\n');
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([5, 6]);
  });

  it('rejects a blank line in the middle', () => {
    const result = validateQueue('app 5\n\napp 6\n');
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('line 2') && e.includes('empty line'))).toBe(true);
  });

  it('rejects malformed entries', () => {
    expect(validateQueue('app five\n').ok).toBe(false);
    expect(validateQueue('app five\n').errors.some(e => e.includes('malformed'))).toBe(true);
    expect(validateQueue('justoneword\n').ok).toBe(false);
    expect(validateQueue('justoneword\n').errors.some(e => e.includes('malformed'))).toBe(true);
  });

  it('rejects issue number 0', () => {
    const result = validateQueue('app 0\n');
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate issues but keeps the first parse', () => {
    const result = validateQueue('app 5\ninfra 5\n');
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('duplicate issue #5'))).toBe(true);
    expect(result.issues).toEqual([5]);
  });

  it('rejects empty or comment-only content', () => {
    expect(validateQueue('').ok).toBe(false);
    expect(validateQueue('').errors).toContain('queue has no issue entries');
    expect(validateQueue('# nothing\n').ok).toBe(false);
    expect(validateQueue('# nothing\n').errors).toContain('queue has no issue entries');
  });
});
