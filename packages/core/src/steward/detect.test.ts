import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RunOutcome } from '../run/outcome.js';
import { detectStuck } from './detect.js';

describe('detectStuck', () => {
  it('flags a parked fail at the rework budget with a signature as check-exhausted', () => {
    const outcome: RunOutcome = {
      state: 'parked',
      reason: 'fail',
      reworkRounds: 3,
      failureSignature: 'sig-abc',
      failingChecks: ['tests'],
    };
    expect(detectStuck(outcome)).toEqual({ trigger: 'check-exhausted', failureSignature: 'sig-abc' });
  });

  it('flags reworkRounds above the budget', () => {
    expect(detectStuck({ state: 'parked', reason: 'fail', reworkRounds: 4, failureSignature: 'sig' })).toEqual({
      trigger: 'check-exhausted',
      failureSignature: 'sig',
    });
  });

  it('honours a custom rework budget', () => {
    expect(detectStuck({ state: 'parked', reason: 'fail', reworkRounds: 1, failureSignature: 'sig' }, 1)).toEqual({
      trigger: 'check-exhausted',
      failureSignature: 'sig',
    });
  });

  it('flags parked ci-failed as ship-failed with a prNumber', () => {
    expect(detectStuck({ state: 'parked', reason: 'ci-failed', prNumber: 42 })).toEqual({ trigger: 'ship-failed' });
  });

  it('flags parked ci-failed without a prNumber', () => {
    expect(detectStuck({ state: 'parked', reason: 'ci-failed' })).toEqual({ trigger: 'ship-failed' });
  });

  it('carries the failureSignature on ship-failed when present', () => {
    expect(detectStuck({ state: 'parked', reason: 'ci-failed', failureSignature: 'sig-ci' })).toEqual({
      trigger: 'ship-failed',
      failureSignature: 'sig-ci',
    });
  });

  it.each<[string, RunOutcome]>([
    ['shipped', { state: 'shipped', route: 'claude', branch: 'b', reworkRounds: 0, prNumber: 1 }],
    ['ready', { state: 'ready', route: 'claude', branch: 'b', reworkRounds: 0 }],
    [
      'released',
      {
        state: 'released',
        reason: 'environment',
        reworkRounds: 3,
        baseSha: 'abc',
        failingChecks: ['tests'],
        failureSignature: 'sig',
      },
    ],
    ['escalated', { state: 'escalated', reason: 'needs human' }],
    ['parked timeout', { state: 'parked', reason: 'timeout' }],
    ['parked conflict', { state: 'parked', reason: 'conflict' }],
    ['parked held', { state: 'parked', reason: 'held', reworkRounds: 3, failureSignature: 'sig' }],
    ['parked escalate', { state: 'parked', reason: 'escalate', reworkRounds: 3, failureSignature: 'sig' }],
    ['budget-style parked fail', { state: 'parked', reason: 'fail', reworkRounds: 3 }],
    ['parked fail below budget', { state: 'parked', reason: 'fail', reworkRounds: 2, failureSignature: 'sig' }],
    ['parked fail with undefined rounds', { state: 'parked', reason: 'fail', failureSignature: 'sig' }],
    ['parked fail with empty signature', { state: 'parked', reason: 'fail', reworkRounds: 3, failureSignature: '' }],
  ])('returns null for %s', (_name, outcome) => {
    expect(detectStuck(outcome)).toBeNull();
  });

  it('does not mutate its input and is repeatable', () => {
    const outcome: RunOutcome = Object.freeze({
      state: 'parked',
      reason: 'fail',
      reworkRounds: 3,
      failureSignature: 'sig',
      failingChecks: ['tests'],
    });
    const before = structuredClone(outcome);
    const first = detectStuck(outcome);
    expect(outcome).toEqual(before);
    expect(detectStuck(outcome)).toEqual(first);
  });

  it('imports only the rework budget const and the outcome type', () => {
    const source = readFileSync(new URL('./detect.ts', import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/^import\s.*?from\s+'([^']+)';$/gm)].map((m) => m[1]);
    expect(specifiers).toEqual(['../phases/check.js', '../run/outcome.js']);
    expect(source).toMatch(/^import type \{ RunOutcome \} from '\.\.\/run\/outcome\.js';$/m);
  });
});
