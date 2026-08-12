import { describe, expect, it } from 'vitest';

import { EVENT_TRAITS, eventTraitsFor, isParkKind, laneStatusOf, severityOf, UNKNOWN_EVENT_TRAITS } from './kinds.js';

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const VALID_LANE_STATUSES = new Set(['running', 'waiting-merge', 'ready', 'merged', 'failed', 'stopped']);

describe('EVENT_TRAITS', () => {
  it('gives every EventKind member a well-formed traits entry', () => {
    const entries = Object.entries(EVENT_TRAITS);
    expect(entries.length).toBeGreaterThan(0);

    for (const [kind, traits] of entries) {
      expect(VALID_SEVERITIES.has(traits.severity), `${kind}: severity`).toBe(true);
      expect(typeof traits.isPark, `${kind}: isPark`).toBe('boolean');
      expect(typeof traits.isTerminal, `${kind}: isTerminal`).toBe('boolean');
      if (traits.laneStatus !== undefined) {
        expect(VALID_LANE_STATUSES.has(traits.laneStatus), `${kind}: laneStatus`).toBe(true);
      }
    }
  });

  it('has no duplicate keys (every kind classified exactly once)', () => {
    const keys = Object.keys(EVENT_TRAITS);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('eventTraitsFor', () => {
  it('returns the matching EVENT_TRAITS entry for a known kind', () => {
    expect(eventTraitsFor('plan')).toEqual(EVENT_TRAITS.plan);
  });

  it('returns UNKNOWN_EVENT_TRAITS for a string outside EventKind, never a default that looks like success', () => {
    const traits = eventTraitsFor('some-made-up-legacy-kind');
    expect(traits).toEqual(UNKNOWN_EVENT_TRAITS);
    expect(traits.severity).toBe('unknown');
    expect(traits).not.toEqual({ severity: 'info', isPark: false, isTerminal: false });
  });
});

describe('severityOf', () => {
  it('maps a known kind to its real LogLevel', () => {
    expect(severityOf('warn')).toBe('warn');
    expect(severityOf('fail')).toBe('error');
    expect(severityOf('plan')).toBe('info');
  });

  it('maps an unknown kind to info (matches the historical default)', () => {
    expect(severityOf('some-made-up-legacy-kind')).toBe('info');
  });
});

describe('isParkKind', () => {
  it('is true for every ParkReason-shaped kind', () => {
    for (const kind of ['escalate', 'timeout', 'fail', 'conflict', 'ci-failed', 'parked', 'stuck']) {
      expect(isParkKind(kind), kind).toBe(true);
    }
  });

  it('is false for a non-park kind and an unknown kind', () => {
    expect(isParkKind('plan')).toBe(false);
    expect(isParkKind('ship_denied')).toBe(false);
    expect(isParkKind('some-made-up-legacy-kind')).toBe(false);
  });
});

describe('laneStatusOf', () => {
  it('maps phase-transition kinds to running', () => {
    for (const kind of ['plan', 'build', 'check', 'ship', 'rework']) {
      expect(laneStatusOf(kind), kind).toBe('running');
    }
  });

  it('maps terminal-failure kinds to failed, including the ci-failed regression (#663)', () => {
    for (const kind of ['fail', 'escalate', 'parked', 'ship_denied', 'timeout', 'conflict', 'ci-failed']) {
      expect(laneStatusOf(kind), kind).toBe('failed');
    }
  });

  it('is undefined for a kind that does not drive lane status', () => {
    expect(laneStatusOf('adr_written')).toBeUndefined();
    expect(laneStatusOf('some-made-up-legacy-kind')).toBeUndefined();
  });
});

// Regression (#663): 'ci-failed' is a real ParkReason emitted when CI fails on land,
// but was absent from every downstream classification set — logged at info instead of
// error, rendered as a dim "other" TUI line, left the lane 'running', and invisible to
// human-intervention KPIs. EVENT_TRAITS is now the single source of truth all of that
// reads from, so this one entry fixes every consumer at once.
describe('ci-failed classification (#663 regression)', () => {
  it('is error severity, park-ish, terminal, and marks the lane failed', () => {
    expect(EVENT_TRAITS['ci-failed']).toEqual({
      severity: 'error',
      isPark: true,
      isTerminal: true,
      laneStatus: 'failed',
    });
  });
});

// A refused run-lock acquisition (#598) is a warning the operator should notice,
// but it neither parks a lane (nothing started) nor ends one (nothing was running).
describe('run_lock_conflict classification (#598)', () => {
  it('is warn severity, not park, not terminal', () => {
    expect(EVENT_TRAITS.run_lock_conflict).toEqual({ severity: 'warn', isPark: false, isTerminal: false });
  });
});
