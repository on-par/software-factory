import { describe, expect, it } from 'vitest';

import { parkEvents, parkReasonFor } from './outcome.js';
import type { RunOutcome } from './outcome.js';

describe('parkReasonFor', () => {
  it('reads the reason off a parked RunOutcome carried on err.outcome (LaneParkError-shaped)', () => {
    expect(parkReasonFor({ outcome: { state: 'parked', reason: 'escalate' } })).toBe('escalate');
    expect(parkReasonFor({ outcome: { state: 'parked', reason: 'fail' } })).toBe('fail');
  });

  it('reads a readonly parkReason marker (Land/Ci-shaped errors)', () => {
    expect(parkReasonFor({ parkReason: 'conflict' })).toBe('conflict');
    expect(parkReasonFor({ parkReason: 'ci-failed' })).toBe('ci-failed');
  });

  it('falls back to timeout when reason is timeout', () => {
    expect(parkReasonFor({ reason: 'timeout' })).toBe('timeout');
  });

  it('defaults to fail for anything else', () => {
    expect(parkReasonFor(new Error('x'))).toBe('fail');
    expect(parkReasonFor(undefined)).toBe('fail');
    expect(parkReasonFor(null)).toBe('fail');
    expect(parkReasonFor('boom')).toBe('fail');
  });
});

describe('parkEvents', () => {
  it('emits a single event for a non-timeout park', () => {
    const err = Object.assign(new Error('x'), { outcome: { state: 'parked' as const, reason: 'escalate' as const } });
    expect(parkEvents(err)).toEqual([{ type: 'escalate', msg: 'x' }]);
  });

  it('derives the message from Error instances', () => {
    expect(parkEvents(new Error('boom'))).toEqual([{ type: 'fail', msg: 'boom' }]);
  });

  it('emits an extra stuck event for a timeout park', () => {
    const events = parkEvents({ reason: 'timeout' });
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('stuck');
  });
});

describe('RunOutcome', () => {
  it('compiles a value for each of the four states', () => {
    const shipped: RunOutcome = { state: 'shipped', route: 'claude', branch: 'b', reworkRounds: 0, prNumber: 1 };
    const ready: RunOutcome = { state: 'ready', route: 'codex', branch: 'b', reworkRounds: 1 };
    const parked: RunOutcome = { state: 'parked', reason: 'fail' };
    const escalated: RunOutcome = { state: 'escalated', reason: 'unknown' };

    expect([shipped, ready, parked, escalated].map((o) => o.state)).toEqual([
      'shipped',
      'ready',
      'parked',
      'escalated',
    ]);
  });
});
