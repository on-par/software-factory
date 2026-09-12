import { describe, expect, it } from 'vitest';

import {
  LANE_LIFECYCLE_PHASES,
  LaneLifecycleEventSchema,
  LaneLifecycleLaneStateSchema,
  LaneLifecyclePhaseSchema,
  LaneLifecycleStatusSchema,
  RepositoryLaneLifecycleEventSchema,
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

  it('parses and round-trips a waiting-merge laneState', () => {
    const event = { ...baseEvent, laneState: 'waiting-merge' };
    expect(LaneLifecycleEventSchema.parse(event).laneState).toBe('waiting-merge');
  });

  it('parses and round-trips a parked laneState', () => {
    const event = { ...baseEvent, laneState: 'parked' };
    expect(LaneLifecycleEventSchema.parse(event).laneState).toBe('parked');
  });

  it('parses a frame without laneState and yields laneState undefined', () => {
    expect(LaneLifecycleEventSchema.parse(baseEvent).laneState).toBeUndefined();
  });

  it('rejects an unknown laneState value', () => {
    expect(() => LaneLifecycleEventSchema.parse({ ...baseEvent, laneState: 'napping' })).toThrow();
  });
});

describe('LaneLifecycleLaneStateSchema', () => {
  it('round-trips each lane state value', () => {
    for (const laneState of ['waiting-merge', 'parked'] as const) {
      expect(LaneLifecycleLaneStateSchema.parse(laneState)).toBe(laneState);
    }
  });
});

describe('RepositoryLaneLifecycleEventSchema', () => {
  it('parses a repo-tagged event and returns the repo', () => {
    const event = { ...baseEvent, repo: 'on-par/software-factory' };
    expect(RepositoryLaneLifecycleEventSchema.parse(event).repo).toBe('on-par/software-factory');
  });

  it('rejects an event missing repo', () => {
    expect(() => RepositoryLaneLifecycleEventSchema.parse(baseEvent)).toThrow();
  });

  it('rejects an empty repo', () => {
    expect(() => RepositoryLaneLifecycleEventSchema.parse({ ...baseEvent, repo: '' })).toThrow();
  });

  it('carries laneState through the repo-scoped schema', () => {
    const event = { ...baseEvent, repo: 'on-par/software-factory', laneState: 'parked' };
    expect(RepositoryLaneLifecycleEventSchema.parse(event).laneState).toBe('parked');
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
