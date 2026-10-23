import { describe, expect, it } from 'vitest';

import { MAX_REPORTED_COOLDOWN_MS } from '../router/breaker.js';
import { classifyCodexFailure, extractCodexErrorText, parseCodexResetAt } from './codex-error.js';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const H = 3_600_000;
const M = 60_000;
const at = (ms: number) => new Date(NOW + ms).toISOString();
const rel = (text: string) => parseCodexResetAt(text, NOW, 'UTC');

describe('parseCodexResetAt', () => {
  it.each([
    ['try again in 2 hours', 2 * H],
    ['try again in 5 minutes.', 5 * M],
    ['Try again in 1 day', 24 * H],
    ['try again in 3 days 4 hours', 76 * H],
    ['try again in 1 hour, 30 mins', 90 * M],
    ['try again in 2 hrs and 5 min.', 125 * M],
  ])('%s', (text, ms) => {
    expect(rel(text)).toBe(at(ms));
  });

  it('returns undefined for zero, unit-less or missing durations', () => {
    expect(rel('try again in 0 minutes')).toBeUndefined();
    expect(rel('try again in 5.')).toBeUndefined();
    expect(rel('try again in ')).toBeUndefined();
    expect(rel('nothing here')).toBeUndefined();
    expect(rel('')).toBeUndefined();
  });

  it('caps huge durations', () => {
    expect(rel('try again in 999999 days')).toBe(at(MAX_REPORTED_COOLDOWN_MS));
  });

  it('parses the absolute form in the zone and rejects bad fields', () => {
    expect(parseCodexResetAt('try again at 3:05 PM.', NOW, 'UTC')).toBe('2026-10-19T15:05:00.000Z');
    expect(parseCodexResetAt('try again at 11:00 am', NOW, 'UTC')).toBe('2026-10-20T11:00:00.000Z');
    expect(parseCodexResetAt('try again at 13:05 PM', NOW, 'UTC')).toBeUndefined();
    expect(parseCodexResetAt('try again at 3:75 PM', NOW, 'UTC')).toBeUndefined();
    expect(parseCodexResetAt('try again at Oct 20th, 2026 3:05 PM', NOW, 'UTC')).toBeUndefined();
    expect(parseCodexResetAt('try again at 3:05 PM', NOW, 'Not/AZone')).toBeUndefined();
  });

  it('runs in linear time on adversarial digit runs', () => {
    const start = Date.now();
    expect(rel('try again in ' + '9'.repeat(100_000))).toBeUndefined();
    expect(rel('9'.repeat(100_000) + ' day')).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('classifyCodexFailure', () => {
  it('gives rate_limit a resetAt', () => {
    const f = classifyCodexFailure('rate_limit', 'rate limit. try again in 30 minutes', NOW, 'UTC');
    expect(f).toMatchObject({ kind: 'rate_limit', resetAt: at(30 * M) });
  });

  it('maps local_auth by credential text', () => {
    expect(classifyCodexFailure('local_auth', 'Missing bearer', NOW, 'UTC').kind).toBe('unavailable');
    expect(classifyCodexFailure('local_auth', 'invalid api key', NOW, 'UTC').kind).toBe('auth');
  });

  it('skips reset parsing for other kinds', () => {
    expect(classifyCodexFailure('error', 'try again in 2 hours', NOW, 'UTC').resetAt).toBeUndefined();
  });
});

describe('extractCodexErrorText', () => {
  it('keeps only error-bearing events', () => {
    const lines = [
      JSON.stringify({ type: 'error', message: 'e1' }),
      JSON.stringify({ type: 'turn.failed', error: { message: 'e2' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'e3' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'prose' } }),
      'not json',
      '',
      '42',
    ];
    expect(extractCodexErrorText(lines.join('\n'))).toBe('e1\ne2\ne3');
  });
});
