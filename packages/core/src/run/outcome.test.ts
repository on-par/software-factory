import { describe, expect, it } from 'vitest';

import { designSmellFindingFor, parkEvents, parkReasonFor, reworkRouteFor } from './outcome.js';
import type { DesignSmellFinding, RunOutcome } from './outcome.js';

const FINDING: DesignSmellFinding = { approachTried: 'cache', whyItStinks: 'stale reads', recommendation: 'split it' };

describe('designSmellFindingFor (#1513)', () => {
  it('reads the finding from a parked err.outcome and from an err.designSmell marker, dropping extra keys', () => {
    expect(designSmellFindingFor({ outcome: { state: 'parked', reason: 'escalate', designSmell: FINDING } })).toEqual(
      FINDING,
    );
    expect(designSmellFindingFor({ designSmell: { ...FINDING, extra: 1 } })).toStrictEqual(FINDING);
  });

  it('ignores missing or incomplete findings (#1513)', () => {
    for (const err of [
      undefined,
      null,
      new Error('x'),
      { designSmell: 'nope' },
      { designSmell: { ...FINDING, approachTried: '  ' } },
      { designSmell: { ...FINDING, whyItStinks: 3 } },
      { designSmell: { approachTried: 'a', whyItStinks: 'b' } },
    ]) {
      expect(designSmellFindingFor(err)).toBeUndefined();
    }
  });

  it('parkEvents attaches the design-smell finding to the park event (#1513)', () => {
    const err = Object.assign(new Error('smell'), {
      outcome: { state: 'parked' as const, reason: 'escalate' as const, designSmell: FINDING },
    });
    expect(parkEvents(err)).toEqual([{ type: 'escalate', msg: 'smell', designSmell: FINDING }]);
  });

  it('never attaches the finding to the stuck companion event', () => {
    const err = Object.assign(new Error('slow'), { reason: 'timeout', designSmell: FINDING });
    const events = parkEvents(err);
    expect(events[0]).toMatchObject({ type: 'timeout', designSmell: FINDING });
    expect(events[1].type).toBe('stuck');
    expect(events[1]).not.toHaveProperty('designSmell');
  });
});

describe('parkReasonFor', () => {
  it('reads the reason off a parked RunOutcome carried on err.outcome (LaneParkError-shaped)', () => {
    expect(parkReasonFor({ outcome: { state: 'parked', reason: 'escalate' } })).toBe('escalate');
    expect(parkReasonFor({ outcome: { state: 'parked', reason: 'fail' } })).toBe('fail');
  });

  it('reads a config park reason (#2584)', () => {
    expect(parkReasonFor({ outcome: { state: 'parked', reason: 'config' } })).toBe('config');
  });

  it('reads a blocked park reason from a marker or a parked outcome (#2315)', () => {
    expect(parkReasonFor({ parkReason: 'blocked' })).toBe('blocked');
    expect(parkReasonFor({ outcome: { state: 'parked', reason: 'blocked' } })).toBe('blocked');
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

  it('emits a single config event with no stuck companion (#2584)', () => {
    const err = Object.assign(new Error('bad config'), {
      outcome: { state: 'parked' as const, reason: 'config' as const },
    });
    expect(parkEvents(err)).toEqual([{ type: 'config', msg: 'bad config' }]);
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

describe('reworkRouteFor', () => {
  it('passes every built route through, command included (#2873)', () => {
    expect(reworkRouteFor('command', 'my-model')).toEqual({ reworkRoute: 'command', reworkModel: 'my-model' });
    expect(reworkRouteFor('codex', undefined)).toEqual({ reworkRoute: 'codex', reworkModel: undefined });
  });
});
