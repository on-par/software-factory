import { describe, expect, it } from 'vitest';

import { median } from './median.js';

describe('median', () => {
  it('returns the median for odd, even, and single-value inputs', () => {
    expect(median([8, 3, 7])).toBe(7);
    expect(median([7, 8])).toBe(7.5);
    expect(median([5])).toBe(5);
  });

  it('does not mutate its input', () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });

  it('returns null for an empty array', () => {
    expect(median([])).toBeNull();
  });
});
