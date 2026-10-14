import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ShipResult } from '../phases/ship.js';
import type { RunOutcome } from '../run/outcome.js';
import { shipParkReason } from '../run/ship-park.js';
import { detectStuck, type StuckDetection } from './detect.js';

describe('detectStuck', () => {
  it('returns null for a blocked park, even with a signature at the rework budget', () => {
    expect(detectStuck({ state: 'parked', reason: 'blocked' })).toBeNull();
    expect(
      detectStuck({
        state: 'parked',
        reason: 'blocked',
        reworkRounds: 3,
        failureSignature: 'sig',
        failingChecks: ['tests'],
      }),
    ).toBeNull();
  });

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

  it('still triggers ship-failed for ci-failed with the same fields as a ci-infra park', () => {
    expect(detectStuck({ state: 'parked', reason: 'ci-failed', prNumber: 5 })).toEqual({ trigger: 'ship-failed' });
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
    ['parked ci-infra', { state: 'parked', reason: 'ci-infra', prNumber: 5 }],
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

describe('detectStuck ci-failed origins', () => {
  it('SHIP-origin ci failure maps to the ci-failed park reason', () => {
    expect(shipParkReason({ ok: false, ciOutcome: 'failure' })).toBe('ci-failed');
  });

  it.each<[string, ShipResult, Partial<RunOutcome>, StuckDetection | null]>([
    ['ci failure with a PR', { ok: false, ciOutcome: 'failure', prNumber: 7 }, {}, { trigger: 'ship-failed' }],
    [
      'ci failure with a signature',
      { ok: false, ciOutcome: 'failure' },
      { failureSignature: 'sig-ci' },
      { trigger: 'ship-failed', failureSignature: 'sig-ci' },
    ],
    ['ci-infra is not a trigger', { ok: false, ciOutcome: 'infra-failure' }, {}, null],
    ['denied escalates, not a trigger', { ok: false, denied: true, deniedReason: 'x' }, {}, null],
    ['plain fail without a signature is not a trigger', { ok: false, reason: 'push failed' }, {}, null],
  ])('SHIP-origin %s', (_name, ship, extra, expected) => {
    const outcome = {
      state: 'parked',
      reason: shipParkReason(ship),
      route: 'claude',
      branch: 'b',
      reworkRounds: 0,
      ...extra,
    } as RunOutcome;
    expect(detectStuck(outcome)).toEqual(expected);
  });

  it.each<[string, Partial<RunOutcome>, StuckDetection]>([
    ['with a PR number', { prNumber: 42 }, { trigger: 'ship-failed' }],
    ['without a PR number', {}, { trigger: 'ship-failed' }],
    ['with a signature', { failureSignature: 'sig-land' }, { trigger: 'ship-failed', failureSignature: 'sig-land' }],
    ['with an empty signature', { failureSignature: '' }, { trigger: 'ship-failed' }],
  ])('land-path ci-failed %s', (_name, extra, expected) => {
    const outcome = { state: 'parked', reason: 'ci-failed', reworkRounds: 0, ...extra } as RunOutcome;
    expect(detectStuck(outcome)).toEqual(expected);
  });
});
