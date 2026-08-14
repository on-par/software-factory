// packages/core/src/run/outcome.test.ts — park classification on core-owned types (#672)
//
// Ports the CLI's park-classification coverage to the core-owned
// parkReasonFor/parkEvents (the CLI's LaneParkError now just carries a
// ParkOutcome that these functions read structurally).

import { describe, expect, it } from 'vitest';

import {
  CiFailedError,
  CiUnverifiedError,
  LandConflictError,
  parkEvents,
  parkReasonFor,
  type ParkOutcome,
} from './outcome.js';

/** A LaneParkError-shaped error: a core ParkOutcome carried as an own field. */
class FakeLaneParkError extends Error {
  constructor(
    message: string,
    readonly outcome: ParkOutcome,
  ) {
    super(message);
  }
}

/** A LandFailureError-shaped error: an unrelated Error subclass that must
 *  default to 'fail' (not park classification). */
class FakeLandFailureError extends Error {}

describe('parkReasonFor', () => {
  it('maps a carried parked outcome to its reason', () => {
    expect(parkReasonFor(new FakeLaneParkError('x', { state: 'parked', reason: 'fail' }))).toBe('fail');
    expect(parkReasonFor(new FakeLaneParkError('x', { state: 'parked', reason: 'conflict' }))).toBe('conflict');
  });

  it('maps a carried escalate outcome to its reason', () => {
    expect(parkReasonFor(new FakeLaneParkError('x', { state: 'parked', reason: 'escalate' }))).toBe('escalate');
    expect(parkReasonFor(new FakeLaneParkError('x', { state: 'parked', reason: 'ci-failed' }))).toBe('ci-failed');
  });

  it('prefers a carried outcome over a marker error and a reason field', () => {
    const err = new LandConflictError('conflict, but outcome wins');
    (err as { outcome?: ParkOutcome }).outcome = { state: 'parked', reason: 'escalate' };
    expect(parkReasonFor(err)).toBe('escalate');
  });

  it('maps a LandConflictError to conflict', () => {
    expect(parkReasonFor(new LandConflictError('x'))).toBe('conflict');
  });

  it('maps a CiFailedError to ci-failed', () => {
    expect(parkReasonFor(new CiFailedError('x', 707))).toBe('ci-failed');
  });

  it('maps a CiUnverifiedError to ci-failed', () => {
    expect(parkReasonFor(new CiUnverifiedError('x', 707))).toBe('ci-failed');
  });

  it('maps an error carrying reason: timeout to timeout', () => {
    expect(parkReasonFor(Object.assign(new Error('x'), { reason: 'timeout' }))).toBe('timeout');
  });

  it('defaults a plain Error or unrelated Error subclass to fail', () => {
    expect(parkReasonFor(new Error('x'))).toBe('fail');
    expect(parkReasonFor(new FakeLandFailureError('x'))).toBe('fail');
  });

  it('defaults non-Error inputs to fail', () => {
    expect(parkReasonFor('oops')).toBe('fail');
    expect(parkReasonFor(undefined)).toBe('fail');
  });
});

describe('parkEvents', () => {
  it('emits a stuck event alongside the timeout event when a run times out', () => {
    const err = Object.assign(new Error('build timed out after 3600s'), { reason: 'timeout' });
    const events = parkEvents(err);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'timeout', msg: 'build timed out after 3600s' });
    expect(events[1].type).toBe('stuck');
    expect(events[1].msg).toContain('phase timeout');
    expect(events[1].msg).toContain('build timed out after 3600s');
  });

  it('emits only the terminal event for non-timeout park reasons', () => {
    expect(parkEvents(new FakeLaneParkError('x', { state: 'parked', reason: 'escalate' }))).toEqual([
      { type: 'escalate', msg: 'x' },
    ]);
    expect(parkEvents(new Error('boom'))).toEqual([{ type: 'fail', msg: 'boom' }]);
    expect(parkEvents(new LandConflictError('rebase conflict'))).toEqual([
      { type: 'conflict', msg: 'rebase conflict' },
    ]);
  });

  it('stringifies a non-Error input', () => {
    expect(parkEvents('oops')).toEqual([{ type: 'fail', msg: 'oops' }]);
  });
});
