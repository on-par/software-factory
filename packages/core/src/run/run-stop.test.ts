import { describe, expect, it } from 'vitest';

import { createRunStop, requestRunStop } from './run-stop.js';

describe('createRunStop', () => {
  it('stops on the deadline minus the margin', () => {
    let now = 0;
    const stop = createRunStop({ deadlineAtMs: 10_000, marginMs: 2_000, now: () => now });
    expect(stop.reason()).toBeUndefined();
    now = 8_000;
    expect(stop.reason()).toBe('deadline');
    stop.dispose();
  });

  it('never stops on time without a deadline', () => {
    const stop = createRunStop({ marginMs: 0, now: () => Number.MAX_SAFE_INTEGER });
    expect(stop.reason()).toBeUndefined();
    stop.dispose();
  });

  it('stops every active run on request and forgets disposed runs', () => {
    const a = createRunStop({ marginMs: 0, now: () => 0 });
    const b = createRunStop({ marginMs: 0, now: () => 0 });
    b.dispose();
    expect(requestRunStop()).toBe(1);
    expect(a.reason()).toBe('sigterm');
    expect(b.reason()).toBeUndefined();
    a.dispose();
    expect(requestRunStop()).toBe(0);
  });
});
