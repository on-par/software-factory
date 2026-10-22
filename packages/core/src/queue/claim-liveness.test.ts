// packages/core/src/queue/claim-liveness.test.ts — the claim-liveness verdict table (#3442)

import { describe, expect, it } from 'vitest';

import { claimIsLive, claimLiveness, type ClaimLiveness } from './claim-liveness.js';

const NOW = 1_800_000_000_000;
const nowS = NOW / 1000;
const lease = (s: number) => `factory:claim-expires:${s}`;
const past = lease(nowS - 60);
const future = lease(nowS + 60);

describe('claimLiveness', () => {
  it.each<[string, string[], ClaimLiveness]>([
    ['empty labels', [], { verdict: 'unclaimed' }],
    ['empty-string label', [''], { verdict: 'unclaimed' }],
    ['queued only', ['factory:queued'], { verdict: 'unclaimed' }],
    ['in-progress only', ['factory:in-progress'], { verdict: 'no-lease' }],
    ['claimed-by only', ['factory:claimed-by:x'], { verdict: 'no-lease' }],
    ['claimed-by + live lease', ['factory:claimed-by:x', future], { verdict: 'live' }],
    [
      'claimed-by + expired lease',
      ['factory:claimed-by:x', past],
      { verdict: 'expired', label: past, expiresAt: nowS - 60 },
    ],
    [
      'in-progress + expired lease',
      ['factory:in-progress', past],
      { verdict: 'expired', label: past, expiresAt: nowS - 60 },
    ],
    ['lease-only live', [future], { verdict: 'live' }],
    ['lease-only expired', [past], { verdict: 'expired', label: past, expiresAt: nowS - 60 }],
    ['malformed lease', ['factory:claim-expires:abc'], { verdict: 'live' }],
    ['unsafe-integer lease', ['factory:claim-expires:99999999999999999999'], { verdict: 'live' }],
    ['expired + live', [past, future], { verdict: 'live' }],
    ['expired + malformed', [past, 'factory:claim-expires:abc'], { verdict: 'live' }],
    [
      'two expired reports the first',
      [past, lease(nowS - 10)],
      { verdict: 'expired', label: past, expiresAt: nowS - 60 },
    ],
    ['lease equal to now is expired', [lease(nowS)], { verdict: 'expired', label: lease(nowS), expiresAt: nowS }],
    ['lease one second ahead is live', [lease(nowS + 1)], { verdict: 'live' }],
  ])('%s', (_name, labels, expected) => {
    expect(claimLiveness(labels, NOW)).toEqual(expected);
  });
});

describe('claimIsLive', () => {
  it.each<[ClaimLiveness, boolean]>([
    [{ verdict: 'live' }, true],
    [{ verdict: 'no-lease' }, true],
    [{ verdict: 'expired', label: past, expiresAt: 1 }, false],
    [{ verdict: 'unclaimed' }, false],
  ])('%j → %s', (liveness, expected) => {
    expect(claimIsLive(liveness)).toBe(expected);
  });
});
