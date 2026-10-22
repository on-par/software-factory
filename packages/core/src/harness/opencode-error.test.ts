import { describe, expect, it } from 'vitest';

import { MAX_REPORTED_COOLDOWN_MS } from '../router/breaker.js';
import { classifyOpenCodeFailure, parseOpenCodeResetAt } from './opencode-error.js';

const NOW = Date.parse('2026-10-20T13:00:00Z');

describe('parseOpenCodeResetAt', () => {
  it('adds a relative duration to now', () => {
    expect(parseOpenCodeResetAt('Resets in 3hr 17min', NOW)).toBe('2026-10-20T16:17:00.000Z');
  });

  it('honours an offset in an absolute reset', () => {
    expect(parseOpenCodeResetAt('limit resets at 2026-11-01T02:00:00+02:00.', NOW)).toBe('2026-11-01T00:00:00.000Z');
  });

  it('ignores a past instant, an offset-less ISO and a zero duration', () => {
    expect(parseOpenCodeResetAt('resets at 2026-10-01T00:00:00Z', NOW)).toBeUndefined();
    expect(parseOpenCodeResetAt('resets at 2026-11-01T00:00:00', NOW)).toBeUndefined();
    expect(parseOpenCodeResetAt('Resets in 0hr 0min', NOW)).toBeUndefined();
  });

  it('caps a far-future instant', () => {
    expect(parseOpenCodeResetAt('resets at 2027-06-01T00:00:00Z', NOW)).toBe(
      new Date(NOW + MAX_REPORTED_COOLDOWN_MS).toISOString(),
    );
  });

  it('prefers the relative form when both are present', () => {
    expect(parseOpenCodeResetAt('Resets in 1hr 0min, resets at 2026-11-01T00:00:00Z', NOW)).toBe(
      '2026-10-20T14:00:00.000Z',
    );
  });
});

describe('classifyOpenCodeFailure', () => {
  it('attaches resetAt for a usage cap', () => {
    expect(classifyOpenCodeFailure('usage_cap', 'Resets in 1hr 0min', NOW)).toEqual({
      kind: 'usage_cap',
      resetAt: '2026-10-20T14:00:00.000Z',
      reason: 'usage_cap',
      detail: 'Resets in 1hr 0min',
    });
  });

  it('omits resetAt for non-cap reasons', () => {
    const failure = classifyOpenCodeFailure('local_auth', 'Resets in 1hr 0min', NOW);
    expect(failure.kind).toBe('unavailable');
    expect('resetAt' in failure).toBe(false);
  });

  it('trims the detail to 400 chars', () => {
    expect(classifyOpenCodeFailure('unknown', `  ${'x'.repeat(500)}`, NOW).detail).toHaveLength(400);
  });
});
