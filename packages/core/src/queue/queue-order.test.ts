// packages/core/src/queue/queue-order.test.ts — headOfLane returns the first ordered issue with its position (#3958).

import { describe, expect, it } from 'vitest';

import { headOfLane } from './queue-order.js';

describe('headOfLane', () => {
  it('returns the lowest-order issue with its position', () => {
    const issues = [
      { number: 7, labels: ['factory:order:3'] },
      { number: 9, labels: ['factory:order:1'] },
    ];
    expect(headOfLane('l', issues)).toEqual({ issue: 9, position: 1 });
  });

  it('returns null for an empty lane', () => {
    expect(headOfLane('l', [])).toBeNull();
  });
});
