import { describe, expect, it } from 'vitest';

import type { FilingPolicy } from './policy.js';
import { isAutoMergeBlocked } from './policy.js';

const policy: FilingPolicy = { selfFixLabel: 'no-auto-merge' };

describe('isAutoMergeBlocked', () => {
  it('is true when the self-fix label is present', () => {
    expect(isAutoMergeBlocked(['bug', 'no-auto-merge'], policy)).toBe(true);
  });

  it('is false when the self-fix label is absent', () => {
    expect(isAutoMergeBlocked(['bug'], policy)).toBe(false);
  });

  it('honors a custom self-fix label', () => {
    expect(isAutoMergeBlocked(['blocked'], { selfFixLabel: 'blocked' })).toBe(true);
    expect(isAutoMergeBlocked(['no-auto-merge'], { selfFixLabel: 'blocked' })).toBe(false);
  });
});
