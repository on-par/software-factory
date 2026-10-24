// packages/core/src/config/awaiting-ci-cap.test.ts — ci.awaitingCiCapHours (#3208)

import { describe, expect, it } from 'vitest';

import { resolveAwaitingCiCapMs } from './index.js';

describe('resolveAwaitingCiCapMs', () => {
  const DAY = 24 * 3_600_000;

  it('defaults to 24 hours and honours an override', () => {
    expect(resolveAwaitingCiCapMs({})).toBe(DAY);
    expect(resolveAwaitingCiCapMs({ ci: { awaitingCiCapHours: 2 } })).toBe(2 * 3_600_000);
  });

  it.each([0, -1, Number.NaN, Infinity])('falls back to the default for %s', (bad) => {
    expect(resolveAwaitingCiCapMs({ ci: { awaitingCiCapHours: bad } })).toBe(DAY);
  });
});
