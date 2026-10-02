import { describe, expect, it } from 'vitest';

import type { FactoryEvent } from '../types/index.js';
import {
  EVENT_TRAITS,
  eventTraitsFor,
  isParkKind,
  laneStatusOf,
  severityOf,
  UNKNOWN_EVENT_TRAITS,
  type LanePausedPayload,
} from './kinds.js';

const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error']);
const VALID_LANE_STATUSES = new Set(['running', 'waiting-merge', 'ready', 'merged', 'failed', 'parked', 'stopped']);

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
  it('classifies merge-gated-override as a non-park warning', () => {
    expect(eventTraitsFor('merge-gated-override')).toEqual({ severity: 'warn', isPark: false, isTerminal: false });
  });

  it('returns the matching EVENT_TRAITS entry for a known kind', () => {
    expect(eventTraitsFor('plan')).toEqual(EVENT_TRAITS.plan);
  });

  it('classifies a retired ADR-writer kind from an older log as unknown', () => {
    expect(eventTraitsFor('adr_written')).toEqual(UNKNOWN_EVENT_TRAITS);
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

  it('maps sandbox_auth_denied to warn and it is never a park kind', () => {
    expect(severityOf('sandbox_auth_denied')).toBe('warn');
    expect(isParkKind('sandbox_auth_denied')).toBe(false);
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

  it('maps genuine-error kinds to failed, including the ci-failed regression (#663)', () => {
    for (const kind of ['fail', 'ship_denied', 'timeout', 'conflict', 'ci-failed']) {
      expect(laneStatusOf(kind), kind).toBe('failed');
    }
  });

  // A lane that self-parks on ambiguity (an oversized issue, a conflicting PR, a
  // decision it can't make alone) stopped safely, not because anything broke — it
  // must read differently from a real error in the TUI (Patrick, 2026-08-20: "if
  // it's parked then we want to use the word park").
  it('maps self-parked kinds to parked, distinct from a genuine failure', () => {
    for (const kind of ['escalate', 'parked', 'held']) {
      expect(laneStatusOf(kind), kind).toBe('parked');
    }
  });

  it('is undefined for a kind that does not drive lane status', () => {
    expect(laneStatusOf('adr_context')).toBeUndefined();
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

// A rework round where the router threw before any model produced output (#642) is a
// warning the operator should notice, but the bounded rework loop keeps running.
describe('rework_model_failed classification (#642)', () => {
  it('is warn severity, not park, not terminal', () => {
    expect(EVENT_TRAITS.rework_model_failed).toEqual({ severity: 'warn', isPark: false, isTerminal: false });
  });
});

// An oversized factory-task issue parked by the enforced size gate (#607) is a warning
// the operator should notice, but the terminal park is still logged as 'escalate' by the
// CLI's parkEvents — so this event must not double-count as its own park.
describe('size-gate-escalated classification (#607)', () => {
  it('is warn severity, not park, not terminal', () => {
    expect(EVENT_TRAITS['size-gate-escalated']).toEqual({ severity: 'warn', isPark: false, isTerminal: false });
  });
});

// A run refused before any resource was committed because the target issue was already
// closed (#681) is a clean terminal outcome, not a park — human-intervention KPIs must
// never count it, and isParkKind must agree.
// Phase/checker timing events (#1321) are inert bookkeeping — info severity,
// never a park or terminal outcome, so they cannot affect KPI accounting.
describe('phase/checker timing event classification (#1321)', () => {
  it('is info severity, not park, not terminal for all four new kinds', () => {
    for (const kind of ['phase_started', 'phase_completed', 'checker_started', 'checker_completed'] as const) {
      expect(EVENT_TRAITS[kind], kind).toEqual({ severity: 'info', isPark: false, isTerminal: false });
    }
  });
});

describe('skipped-already-closed classification (#681)', () => {
  it('is info severity, not park, terminal', () => {
    expect(EVENT_TRAITS['skipped-already-closed']).toEqual({ severity: 'info', isPark: false, isTerminal: true });
  });

  it('isParkKind is false — a skip must never count as human intervention', () => {
    expect(isParkKind('skipped-already-closed')).toBe(false);
  });
});

describe('lane-paused', () => {
  it('is registered in EVENT_TRAITS', () => {
    expect(Object.hasOwn(EVENT_TRAITS, 'lane-paused')).toBe(true);
    expect(EVENT_TRAITS['lane-paused']).toEqual({ severity: 'warn', isPark: false, isTerminal: false });
  });

  it('classifies as a warn, non-park, status-less kind', () => {
    expect(eventTraitsFor('lane-paused')).not.toBe(UNKNOWN_EVENT_TRAITS);
    expect(severityOf('lane-paused')).toBe('warn');
    expect(isParkKind('lane-paused')).toBe(false);
    expect(laneStatusOf('lane-paused')).toBeUndefined();
  });

  it('requires lane, signature, failing checks and both issue numbers', () => {
    const payload: LanePausedPayload = {
      lane: 'lane-1',
      signature: 'tests|lint',
      failingChecks: ['tests', 'lint'],
      firstIssue: 10,
      secondIssue: 11,
    };
    const event: FactoryEvent = {
      ts: '2026-01-01T00:00:00.000Z',
      type: 'lane-paused',
      issue: '11',
      msg: 'lane paused',
      lanePaused: payload,
    };
    expect(event.lanePaused).toEqual(payload);

    // @ts-expect-error lane is required
    const noLane: LanePausedPayload = { signature: 's', failingChecks: [], firstIssue: 1, secondIssue: 2 };
    // @ts-expect-error signature is required
    const noSignature: LanePausedPayload = { lane: 'l', failingChecks: [], firstIssue: 1, secondIssue: 2 };
    // @ts-expect-error failingChecks is required
    const noChecks: LanePausedPayload = { lane: 'l', signature: 's', firstIssue: 1, secondIssue: 2 };
    // @ts-expect-error firstIssue is required
    const noFirst: LanePausedPayload = { lane: 'l', signature: 's', failingChecks: [], secondIssue: 2 };
    // @ts-expect-error secondIssue is required
    const noSecond: LanePausedPayload = { lane: 'l', signature: 's', failingChecks: [], firstIssue: 1 };
    expect([noLane, noSignature, noChecks, noFirst, noSecond]).toHaveLength(5);
  });
});
