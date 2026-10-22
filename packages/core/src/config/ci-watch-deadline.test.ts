import { describe, expect, it } from 'vitest';

import { resolveCiWatchDeadlineMs } from './index.js';

describe('resolveCiWatchDeadlineMs', () => {
  it('defaults to 10 minutes and reads ci.watchMinutes', () => {
    expect(resolveCiWatchDeadlineMs({})).toBe(600_000);
    expect(resolveCiWatchDeadlineMs({ ci: {} })).toBe(600_000);
    expect(resolveCiWatchDeadlineMs({ ci: { watchMinutes: 25 } })).toBe(1_500_000);
    expect(resolveCiWatchDeadlineMs({ ci: { watchMinutes: 12.5 } })).toBe(750_000);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])('falls back to the default for %s', (watchMinutes) => {
    expect(resolveCiWatchDeadlineMs({ ci: { watchMinutes } })).toBe(600_000);
  });
});
