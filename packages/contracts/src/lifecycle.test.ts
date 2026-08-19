import { describe, expect, it } from 'vitest';

import {
  LANE_LIFECYCLE_PHASES,
  LaneLifecycleEventSchema,
  LaneLifecyclePhaseSchema,
  LaneLifecycleStatusSchema,
} from './lifecycle.js';

const baseEvent = {
  ts: '2026-08-19T00:00:00.000Z',
  laneId: 'lane-1',
  issueId: '591',
  phase: 'plan',
  status: 'started',
  detail: 'plan started',
  worktreePath: '/tmp/worktree',
};

describe('LaneLifecycleEventSchema', () => {
  it('parses a fully-populated event', () => {
    expect(LaneLifecycleEventSchema.parse(baseEvent)).toEqual(baseEvent);
  });

  it('parses every phase value', () => {
    for (const phase of LANE_LIFECYCLE_PHASES) {
      expect(LaneLifecycleEventSchema.parse({ ...baseEvent, phase }).phase).toBe(phase);
    }
  });

  it('parses every status value', () => {
    for (const status of ['started', 'progress', 'done', 'failed'] as const) {
      expect(LaneLifecycleEventSchema.parse({ ...baseEvent, status }).status).toBe(status);
    }
  });

  it('rejects an unknown phase', () => {
    expect(() => LaneLifecycleEventSchema.parse({ ...baseEvent, phase: 'deploy' })).toThrow();
  });

  it('rejects an unknown status', () => {
    expect(() => LaneLifecycleEventSchema.parse({ ...baseEvent, status: 'queued' })).toThrow();
  });

  it('rejects a missing worktreePath', () => {
    const { worktreePath: _worktreePath, ...withoutWorktreePath } = baseEvent;
    expect(() => LaneLifecycleEventSchema.parse(withoutWorktreePath)).toThrow();
  });
});

describe('LaneLifecyclePhaseSchema', () => {
  it('round-trips each phase in LANE_LIFECYCLE_PHASES', () => {
    for (const phase of LANE_LIFECYCLE_PHASES) {
      expect(LaneLifecyclePhaseSchema.parse(phase)).toBe(phase);
    }
  });
});

describe('LaneLifecycleStatusSchema', () => {
  it('rejects a non-string value', () => {
    expect(() => LaneLifecycleStatusSchema.parse(42)).toThrow();
  });
});
