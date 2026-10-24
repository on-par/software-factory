// packages/cli/src/cli/host-claim-guards.test.ts — host load and disk guards for lane claims (#3048, #2284)

import { loadFactoryConfig } from '@on-par/factory-core';
import { describe, expect, it } from 'vitest';

import { hostClaimGuards } from './host-claim-guards.js';

const where = { repoRoot: '/repo', ghRepo: 'o/r', stateRoot: '/repo/.factory' };

describe('hostClaimGuards', () => {
  it('gives local-queue lanes neither guard', () => {
    expect(hostClaimGuards(loadFactoryConfig(), where, true)).toEqual({});
  });

  it('gives remote lanes both guards', () => {
    const guards = hostClaimGuards(loadFactoryConfig(), where, false);
    expect(guards.loadGuard?.().kind).toMatch(/claim|hold/);
    expect(guards.diskGuard?.().kind).toMatch(/claim|hold/);
  });
});
