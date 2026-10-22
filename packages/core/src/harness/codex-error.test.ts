import { describe, expect, it } from 'vitest';

import { MAX_REPORTED_COOLDOWN_MS } from '../router/breaker.js';
import { classifyCodexFailure, parseCodexResetAt } from './codex-error.js';

const NOW = Date.parse('2026-10-19T12:00:00Z');

describe('parseCodexResetAt', () => {
  it('sums days, hours and minutes', () => {
    expect(parseCodexResetAt('try again in 1 days 2 hours 5 minutes.', NOW, 'UTC')).toBe('2026-10-20T14:05:00.000Z');
  });

  it('accepts singular and single units', () => {
    expect(parseCodexResetAt('try again in 1 day', NOW, 'UTC')).toBe('2026-10-20T12:00:00.000Z');
    expect(parseCodexResetAt('try again in 45 minutes', NOW, 'UTC')).toBe('2026-10-19T12:45:00.000Z');
    expect(parseCodexResetAt('try again in 2 hours, and 3 mins', NOW, 'UTC')).toBe('2026-10-19T14:03:00.000Z');
  });

  it('returns undefined for a zero duration', () => {
    expect(parseCodexResetAt('try again in 0 minutes', NOW, 'UTC')).toBeUndefined();
  });

  it('caps a huge duration at MAX_REPORTED_COOLDOWN_MS', () => {
    expect(parseCodexResetAt('try again in 400 days', NOW, 'UTC')).toBe(
      new Date(NOW + MAX_REPORTED_COOLDOWN_MS).toISOString(),
    );
  });

  it('resolves an absolute time to the next occurrence in the zone', () => {
    expect(parseCodexResetAt('try again at 3:05 PM', NOW, 'America/Chicago')).toBe('2026-10-19T20:05:00.000Z');
    expect(parseCodexResetAt('try again at 3:05 PM', Date.parse('2026-10-19T21:00:00Z'), 'America/Chicago')).toBe(
      '2026-10-20T20:05:00.000Z',
    );
  });

  it('rejects out-of-range fields, the dated form, no phrase and an invalid zone', () => {
    expect(parseCodexResetAt('try again at 13:05 PM', NOW, 'UTC')).toBeUndefined();
    expect(parseCodexResetAt('try again at 3:75 PM', NOW, 'UTC')).toBeUndefined();
    expect(parseCodexResetAt('try again at Oct 20th, 2026 3:05 PM', NOW, 'UTC')).toBeUndefined();
    expect(parseCodexResetAt('usage limit', NOW, 'UTC')).toBeUndefined();
    expect(parseCodexResetAt('try again at 3:05 PM', NOW, 'Not/AZone')).toBeUndefined();
  });
});

describe('classifyCodexFailure', () => {
  it('reports resetAt for usage_cap and rate_limit', () => {
    expect(classifyCodexFailure('usage_cap', 'try again in 2 hours', NOW, 'UTC')).toMatchObject({
      kind: 'usage_cap',
      resetAt: '2026-10-19T14:00:00.000Z',
    });
    expect(classifyCodexFailure('rate_limit', 'try again in 2 hours', NOW, 'UTC').kind).toBe('rate_limit');
  });

  it('maps local_auth to auth', () => {
    expect(classifyCodexFailure('local_auth', '401', NOW, 'UTC').kind).toBe('auth');
  });

  it('gives no resetAt for other kinds', () => {
    expect(classifyCodexFailure('timeout', 'try again in 2 hours', NOW, 'UTC').resetAt).toBeUndefined();
  });
});
