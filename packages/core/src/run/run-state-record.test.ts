import { describe, expect, it } from 'vitest';

import type { RunOutcome } from './outcome.js';
import { terminalRunStateUpdate } from './run-state-record.js';

const ready = (extra: Partial<Extract<RunOutcome, { state: 'ready' }>> = {}): RunOutcome => ({
  state: 'ready',
  route: 'claude',
  branch: 'ship-it/7-x',
  reworkRounds: 0,
  prNumber: 12,
  ...extra,
});

describe('terminalRunStateUpdate draftReason (#3932)', () => {
  it('carries the ready outcome draftReason into the update', () => {
    expect(terminalRunStateUpdate(ready({ draftReason: 'ci-pending' }), undefined).draftReason).toBe('ci-pending');
  });

  it('omits draftReason when the outcome has none', () => {
    expect(terminalRunStateUpdate(ready(), undefined)).not.toHaveProperty('draftReason');
  });
});
