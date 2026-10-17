import { describe, expect, it } from 'vitest';

import { laneLabel, laneSlug, MAX_LABEL_NAME_LENGTH } from './github-queue.js';

describe('lane slug (#3100)', () => {
  it('laneLabel gives distinct labels to two 60-char lane names sharing a 37-char prefix', () => {
    const a = laneLabel('x'.repeat(37) + 'a'.repeat(23));
    const b = laneLabel('x'.repeat(37) + 'b'.repeat(23));
    expect(a).not.toBe(b);
    for (const l of [a, b]) {
      expect(l.length).toBeLessThanOrEqual(MAX_LABEL_NAME_LENGTH);
      expect(l.startsWith('factory:lane:')).toBe(true);
    }
  });

  it('laneSlug leaves a slug that fits the budget unchanged', () => {
    expect(laneSlug('x'.repeat(37))).toBe('x'.repeat(37));
    expect(laneSlug('Feature/Big Lane')).toBe('feature-big-lane');
  });

  it('laneSlug is stable for a long name', () => {
    expect(laneSlug('y'.repeat(80))).toBe(laneSlug('y'.repeat(80)));
  });
});
