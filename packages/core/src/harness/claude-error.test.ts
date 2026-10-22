import { describe, expect, it } from 'vitest';

import { classifyClaudeFailure, parseClaudeResetAt } from './claude-error.js';

const INCIDENT = "You've hit your weekly limit · resets Oct 20 at 7am (America/Chicago)";
const NOW = Date.parse('2026-10-18T22:39:00Z');

describe('parseClaudeResetAt', () => {
  it('resolves the weekly form in the named zone', () => {
    expect(parseClaudeResetAt(INCIDENT, NOW)).toBe('2026-10-20T12:00:00.000Z');
  });

  it('resolves a 5-hour time-only reset to the next occurrence', () => {
    const now = Date.parse('2026-10-19T13:00:00Z');
    expect(parseClaudeResetAt('resets 7am (America/Chicago)', now)).toBe('2026-10-20T12:00:00.000Z');
    expect(parseClaudeResetAt('resets 7am (America/Chicago)', Date.parse('2026-10-19T10:00:00Z'))).toBe(
      '2026-10-19T12:00:00.000Z',
    );
  });

  it('reads minutes and 12am/12pm', () => {
    expect(parseClaudeResetAt('resets 7:30pm (UTC)', Date.parse('2026-10-19T00:00:00Z'))).toBe(
      '2026-10-19T19:30:00.000Z',
    );
    expect(parseClaudeResetAt('resets 12am (UTC)', Date.parse('2026-10-19T05:00:00Z'))).toBe(
      '2026-10-20T00:00:00.000Z',
    );
    expect(parseClaudeResetAt('resets 12pm (UTC)', Date.parse('2026-10-19T05:00:00Z'))).toBe(
      '2026-10-19T12:00:00.000Z',
    );
  });

  it('rolls the year over for a January reset seen in December', () => {
    expect(parseClaudeResetAt('resets Jan 2 at 9am (UTC)', Date.parse('2026-12-30T00:00:00Z'))).toBe(
      '2027-01-02T09:00:00.000Z',
    );
  });

  it('handles a DST change between now and the reset', () => {
    expect(parseClaudeResetAt('resets 7am (America/Chicago)', Date.parse('2026-10-31T13:00:00Z'))).toBe(
      '2026-11-01T13:00:00.000Z',
    );
  });

  it('returns undefined for no match, bad fields, or an unknown zone', () => {
    expect(parseClaudeResetAt('', NOW)).toBeUndefined();
    expect(parseClaudeResetAt('rate limit exceeded', NOW)).toBeUndefined();
    expect(parseClaudeResetAt('resets Foo 20 at 7am (UTC)', NOW)).toBeUndefined();
    expect(parseClaudeResetAt('resets Oct 32 at 7am (UTC)', NOW)).toBeUndefined();
    expect(parseClaudeResetAt('resets Oct 0 at 7am (UTC)', NOW)).toBeUndefined();
    expect(parseClaudeResetAt('resets 13am (UTC)', NOW)).toBeUndefined();
    expect(parseClaudeResetAt('resets 0am (UTC)', NOW)).toBeUndefined();
    expect(parseClaudeResetAt('resets 7:75am (UTC)', NOW)).toBeUndefined();
    expect(parseClaudeResetAt('resets 7am (Not/AZone)', NOW)).toBeUndefined();
    expect(parseClaudeResetAt('resets Oct 20 at 7am (Not/AZone)', NOW)).toBeUndefined();
  });
});

describe('classifyClaudeFailure', () => {
  it('classifies the weekly limit as usage_cap with resetAt', () => {
    expect(classifyClaudeFailure(INCIDENT, 0, NOW)).toEqual({
      kind: 'usage_cap',
      reason: 'usage_cap',
      resetAt: '2026-10-20T12:00:00.000Z',
      detail: INCIDENT,
    });
  });

  it('keeps usage_cap without resetAt for an unparseable zone', () => {
    const f = classifyClaudeFailure("You've hit your limit · resets 7am (Not/AZone)", 1, NOW);
    expect(f.reason).toBe('usage_cap');
    expect(f.resetAt).toBeUndefined();
  });

  it('classifies a rate-limit message with a reset time as rate_limit', () => {
    expect(classifyClaudeFailure('rate limit exceeded, resets 7am (UTC)', 1, NOW).kind).toBe('rate_limit');
  });

  it('falls back to classifyFailure and maps exit-0 unknown to error', () => {
    expect(classifyClaudeFailure('rate limit exceeded', 0, NOW)).toMatchObject({ reason: 'rate_limit' });
    expect(classifyClaudeFailure('something odd', 0, NOW)).toMatchObject({ reason: 'error', kind: 'unavailable' });
    expect(classifyClaudeFailure('', 0, NOW)).toMatchObject({ reason: 'error' });
  });

  it('classifies a zero-token result without limit text as unavailable', () => {
    expect(classifyClaudeFailure('', 0, NOW, { zeroTokenResult: true })).toMatchObject({
      reason: 'unavailable',
      kind: 'unavailable',
    });
  });

  it('truncates the detail', () => {
    expect(classifyClaudeFailure(`  ${'x'.repeat(900)}  `, 0, NOW).detail).toHaveLength(400);
  });
});
