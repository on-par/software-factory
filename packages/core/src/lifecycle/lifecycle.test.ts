import { describe, expect, it } from 'vitest';

import type { LaneStatus } from '../events/event-traits.js';
import { prRunStatusFor, type PrRunStatus } from '../run/pr-run-state.js';
import type { RunStatus } from '../types/index.js';
import {
  assertLifecycleTransition,
  canTransitionLifecycle,
  describeLifecycle,
  FINAL_LIFECYCLE_STATES,
  fromLaneStatus,
  fromRunStatus,
  isFinalLifecycleState,
  isResumableLifecycleState,
  isTerminalLifecycleState,
  laneStatusFromLifecycle,
  LIFECYCLE_LABELS,
  LIFECYCLE_STATES,
  LIFECYCLE_TRANSITIONS,
  type LifecycleState,
  LifecycleTransitionError,
  prRunStatusFromLifecycle,
  RESUMABLE_LIFECYCLE_STATES,
  TERMINAL_LIFECYCLE_STATES,
  toRunStatus,
} from './lifecycle.js';

// The documented canonical representative for every persisted RunStatus. Declared as a `Record`
// so adding a member to RunStatus is a compile error until this table names it (exhaustiveness
// guard), and its values pin the exact representative — not just the round-trip inverse.
const CANONICAL_OF_RUN_STATUS: Record<RunStatus, LifecycleState> = {
  pending: 'queued',
  planning: 'planning',
  building: 'building',
  checking: 'checking',
  reworking: 'reworking',
  shipping: 'shipping',
  ready: 'ready',
  'awaiting-review': 'awaiting-review',
  parked: 'parked',
  escalated: 'escalated',
  merged: 'merged',
  failed: 'failed',
};

const CANONICAL_OF_LANE_STATUS: Record<LaneStatus, LifecycleState> = {
  running: 'building',
  'waiting-merge': 'awaiting-review',
  ready: 'ready',
  merged: 'merged',
  failed: 'failed',
  parked: 'parked',
  stopped: 'stopped',
};

// Full projection tables, so a wrong collapse (e.g. `paused` -> `failed` instead of `parked`) or a
// wrong canonical representative fails rather than passing through a lenient round-trip.
const RUN_STATUS_OF: Record<LifecycleState, RunStatus> = {
  queued: 'pending',
  claimed: 'pending',
  planning: 'planning',
  building: 'building',
  checking: 'checking',
  reworking: 'reworking',
  shipping: 'shipping',
  'awaiting-ci': 'shipping',
  'awaiting-review': 'awaiting-review',
  ready: 'ready',
  merged: 'merged',
  parked: 'parked',
  escalated: 'escalated',
  failed: 'failed',
  stopped: 'pending',
  paused: 'pending',
};

const LANE_STATUS_OF: Record<LifecycleState, LaneStatus | undefined> = {
  queued: undefined,
  claimed: 'running',
  planning: 'running',
  building: 'running',
  checking: 'running',
  reworking: 'running',
  shipping: 'running',
  'awaiting-ci': 'running',
  'awaiting-review': 'waiting-merge',
  ready: 'ready',
  merged: 'merged',
  parked: 'parked',
  escalated: 'failed',
  failed: 'failed',
  stopped: 'stopped',
  paused: 'parked',
};

const PR_RUN_STATUS_OF: Record<LifecycleState, PrRunStatus> = {
  queued: 'building',
  claimed: 'building',
  planning: 'building',
  building: 'building',
  checking: 'building',
  reworking: 'building',
  shipping: 'awaiting-ci',
  'awaiting-ci': 'awaiting-ci',
  'awaiting-review': 'awaiting-review',
  ready: 'awaiting-review',
  merged: 'awaiting-review',
  parked: 'parked',
  escalated: 'parked',
  failed: 'parked',
  stopped: 'parked',
  paused: 'parked',
};

const RUN_STATUSES = Object.keys(CANONICAL_OF_RUN_STATUS) as RunStatus[];
const LANE_STATUSES = Object.keys(CANONICAL_OF_LANE_STATUS) as LaneStatus[];

describe('lifecycle', () => {
  describe('state table', () => {
    it('defines a label, a projection and a transition row for every state', () => {
      for (const state of LIFECYCLE_STATES) {
        expect(LIFECYCLE_LABELS[state]).toBeTruthy();
        expect(LIFECYCLE_TRANSITIONS[state]).toBeDefined();
        expect(toRunStatus(state)).toBe(RUN_STATUS_OF[state]);
        expect(prRunStatusFromLifecycle(state)).toBe(PR_RUN_STATUS_OF[state]);
      }
    });

    it('only lists known states as transition targets', () => {
      const known = new Set<LifecycleState>(LIFECYCLE_STATES);
      for (const state of LIFECYCLE_STATES) {
        for (const next of LIFECYCLE_TRANSITIONS[state]) expect(known.has(next)).toBe(true);
      }
    });

    it('gives every non-final state an outgoing edge and every final state none', () => {
      for (const state of LIFECYCLE_STATES) {
        if (isFinalLifecycleState(state)) expect(LIFECYCLE_TRANSITIONS[state]).toEqual([]);
        else expect(LIFECYCLE_TRANSITIONS[state].length).toBeGreaterThan(0);
      }
    });

    it('partitions every state into exactly one terminal / resumable / final flag set', () => {
      expect([...TERMINAL_LIFECYCLE_STATES].sort()).toEqual(
        ['escalated', 'failed', 'merged', 'parked', 'stopped'].sort(),
      );
      expect([...RESUMABLE_LIFECYCLE_STATES].sort()).toEqual(
        ['escalated', 'failed', 'parked', 'paused', 'stopped'].sort(),
      );
      expect([...FINAL_LIFECYCLE_STATES]).toEqual(['merged']);
      // Widened so `.has()` accepts any LifecycleState, not just the narrow tuple members.
      const terminal = new Set<LifecycleState>(TERMINAL_LIFECYCLE_STATES);
      const resumable = new Set<LifecycleState>(RESUMABLE_LIFECYCLE_STATES);
      const final = new Set<LifecycleState>(FINAL_LIFECYCLE_STATES);
      for (const state of LIFECYCLE_STATES) {
        expect(isTerminalLifecycleState(state)).toBe(terminal.has(state));
        expect(isResumableLifecycleState(state)).toBe(resumable.has(state));
        expect(isFinalLifecycleState(state)).toBe(final.has(state));
      }
    });

    it('sweeps every 16x16 transition against the table', () => {
      for (const from of LIFECYCLE_STATES) {
        for (const to of LIFECYCLE_STATES) {
          expect(canTransitionLifecycle(from, to)).toBe(LIFECYCLE_TRANSITIONS[from].includes(to));
        }
      }
    });
  });

  describe('transitions', () => {
    it('accepts a legal edge and rejects an illegal one', () => {
      expect(canTransitionLifecycle('queued', 'claimed')).toBe(true);
      expect(canTransitionLifecycle('building', 'checking')).toBe(true);
      expect(canTransitionLifecycle('merged', 'building')).toBe(false);
      expect(assertLifecycleTransition('queued', 'claimed')).toBe('claimed');
    });

    it('throws a LifecycleTransitionError naming both states for an illegal edge', () => {
      expect(() => assertLifecycleTransition('merged', 'building')).toThrow(LifecycleTransitionError);
      try {
        assertLifecycleTransition('merged', 'building');
      } catch (error) {
        expect(error).toBeInstanceOf(LifecycleTransitionError);
        const err = error as LifecycleTransitionError;
        expect(err.name).toBe('LifecycleTransitionError');
        expect(err.from).toBe('merged');
        expect(err.to).toBe('building');
        expect(err.message).toBe('illegal lifecycle transition: merged -> building');
      }
    });

    it('never lets a final state move', () => {
      for (const state of FINAL_LIFECYCLE_STATES) {
        expect(LIFECYCLE_TRANSITIONS[state]).toEqual([]);
      }
    });

    it('allows every resumable state to return to queued', () => {
      for (const state of RESUMABLE_LIFECYCLE_STATES) {
        expect(canTransitionLifecycle(state, 'queued')).toBe(true);
      }
    });
  });

  describe('RunStatus projections', () => {
    it('maps every RunStatus to its documented canonical representative', () => {
      for (const status of RUN_STATUSES) expect(fromRunStatus(status)).toBe(CANONICAL_OF_RUN_STATUS[status]);
      expect(Object.keys(CANONICAL_OF_RUN_STATUS).sort()).toEqual([...RUN_STATUSES].sort());
    });

    it('round-trips every RunStatus through the canonical state', () => {
      for (const status of RUN_STATUSES) expect(toRunStatus(fromRunStatus(status))).toBe(status);
    });

    it('projects every state to the exact documented RunStatus (including the lossy collapses)', () => {
      for (const state of LIFECYCLE_STATES) expect(toRunStatus(state)).toBe(RUN_STATUS_OF[state]);
    });

    it('projects to the same PR run status as prRunStatusFor (no ciPending refinement)', () => {
      for (const status of RUN_STATUSES) {
        expect(prRunStatusFromLifecycle(fromRunStatus(status))).toBe(prRunStatusFor(status, false));
      }
    });

    it('projects the canonical-only states to a valid PrRunStatus', () => {
      expect(prRunStatusFromLifecycle('claimed')).toBe('building');
      expect(prRunStatusFromLifecycle('awaiting-ci')).toBe('awaiting-ci');
      expect(prRunStatusFromLifecycle('stopped')).toBe('parked');
      expect(prRunStatusFromLifecycle('paused')).toBe('parked');
    });
  });

  describe('LaneStatus projections', () => {
    it('maps every LaneStatus to its documented canonical representative', () => {
      for (const status of LANE_STATUSES) expect(fromLaneStatus(status)).toBe(CANONICAL_OF_LANE_STATUS[status]);
      expect(Object.keys(CANONICAL_OF_LANE_STATUS).sort()).toEqual([...LANE_STATUSES].sort());
    });

    it('round-trips every LaneStatus through the canonical state', () => {
      for (const status of LANE_STATUSES) expect(laneStatusFromLifecycle(fromLaneStatus(status))).toBe(status);
    });

    it('projects every state to the exact documented LaneStatus', () => {
      for (const state of LIFECYCLE_STATES) expect(laneStatusFromLifecycle(state)).toBe(LANE_STATUS_OF[state]);
    });

    it('has no lane status before a lane exists and folds paused onto parked', () => {
      expect(laneStatusFromLifecycle('queued')).toBeUndefined();
      expect(laneStatusFromLifecycle('escalated')).toBe('failed');
      expect(laneStatusFromLifecycle('paused')).toBe('parked');
    });
  });

  describe('descriptor (AX surface)', () => {
    it('describes a complete, JSON-serializable machine', () => {
      const descriptor = describeLifecycle();
      expect(descriptor.version).toBe(1);
      expect(Object.keys(descriptor.states).sort()).toEqual([...LIFECYCLE_STATES].sort());
      expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
    });

    it('reports every state exactly as the primitives describe it (drift-proof cross-check)', () => {
      const descriptor = describeLifecycle();
      for (const state of LIFECYCLE_STATES) {
        const laneStatus = laneStatusFromLifecycle(state);
        expect(descriptor.states[state]).toEqual({
          label: LIFECYCLE_LABELS[state],
          terminal: isTerminalLifecycleState(state),
          resumable: isResumableLifecycleState(state),
          final: isFinalLifecycleState(state),
          runStatus: toRunStatus(state),
          ...(laneStatus === undefined ? {} : { laneStatus }),
          prRunStatus: prRunStatusFromLifecycle(state),
          next: LIFECYCLE_TRANSITIONS[state],
        });
      }
    });

    it('models a paused state that the legacy LaneStatus cannot express', () => {
      expect(LIFECYCLE_STATES).toContain('paused');
      expect(isResumableLifecycleState('paused')).toBe(true);
      expect(describeLifecycle().states.paused.label).toBe('Paused');
    });
  });
});
