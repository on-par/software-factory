import { describe, expect, it } from 'vitest';
import type { FactoryEvent } from '@on-par/factory-core';
import {
  initialDashboard,
  isLaneEvent,
  laneElapsedMs,
  mergeTrainPosition,
  reduceDashboard,
  type DashboardState,
} from './dashboard.js';

function ev(type: string, issue: string, msg: string, ts = '2026-01-01T00:00:00.000Z'): FactoryEvent {
  return { ts, type, issue, msg };
}

function reduceAll(events: FactoryEvent[]): DashboardState {
  return events.reduce(reduceDashboard, initialDashboard());
}

describe('isLaneEvent', () => {
  it('is true only for numeric-string issue ids', () => {
    expect(isLaneEvent(ev('plan', '296', 'x'))).toBe(true);
    expect(isLaneEvent(ev('triage', '-', 'x'))).toBe(false);
    expect(isLaneEvent(ev('run-done', 'all', 'x'))).toBe(false);
    expect(isLaneEvent(ev('watchdog', 'usage', 'x'))).toBe(false);
    expect(isLaneEvent(ev('lane-done', 'app', 'x'))).toBe(false);
  });
});

describe('reduceDashboard — lane creation and independence', () => {
  it('creates lanes in first-event order and advances each lane independently', () => {
    const state = reduceAll([
      ev('plan', '296', 'Starting plan phase', '2026-01-01T00:00:00.000Z'),
      ev('plan', '301', 'Starting plan phase', '2026-01-01T00:00:01.000Z'),
      ev('plan', '305', 'Starting plan phase', '2026-01-01T00:00:02.000Z'),
    ]);

    expect(state.lanes.map(l => l.issue)).toEqual(['296', '301', '305']);
    expect(state.lanes.every(l => l.run.activePhase === 'PLAN')).toBe(true);

    const afterBuild = reduceDashboard(state, ev('build', '301', 'Starting build phase (route: claude)'));
    const lane296 = afterBuild.lanes.find(l => l.issue === '296')!;
    const lane301 = afterBuild.lanes.find(l => l.issue === '301')!;
    expect(lane296.run.activePhase).toBe('PLAN');
    expect(lane301.run.activePhase).toBe('BUILD');
  });
});

describe('reduceDashboard — lifecycle events', () => {
  it('issue-title sets the lane title', () => {
    const state = reduceAll([
      ev('plan', '296', 'Starting plan phase'),
      ev('issue-title', '296', 'Add multi-lane dashboard'),
    ]);
    expect(state.lanes[0].title).toBe('Add multi-lane dashboard');
  });

  it('ready sets status to ready and parses the PR number', () => {
    const state = reduceAll([
      ev('plan', '296', 'Starting plan phase'),
      ev('ready', '296', 'PR #123 ready for review'),
    ]);
    expect(state.lanes[0].status).toBe('ready');
    expect(state.lanes[0].prNumber).toBe('123');
  });

  it('ready without a parseable PR number leaves prNumber unset', () => {
    const state = reduceAll([
      ev('plan', '296', 'Starting plan phase'),
      ev('ready', '296', 'ready for review'),
    ]);
    expect(state.lanes[0].status).toBe('ready');
    expect(state.lanes[0].prNumber).toBeUndefined();
  });

  it('await-merge sets waiting-merge and keeps the first waitingSince on repeat', () => {
    const state = reduceAll([
      ev('plan', '296', 'Starting plan phase'),
      ev('await-merge', '296', 'waiting to merge ship-it/296-x', '2026-01-01T00:05:00.000Z'),
      ev('await-merge', '296', 'waiting to merge ship-it/296-x', '2026-01-01T00:06:00.000Z'),
    ]);
    expect(state.lanes[0].status).toBe('waiting-merge');
    expect(state.lanes[0].waitingSince).toBe('2026-01-01T00:05:00.000Z');
  });

  it('landed sets status merged and freezes finishedAt', () => {
    const state = reduceAll([
      ev('plan', '296', 'Starting plan phase'),
      ev('landed', '296', 'PR merged', '2026-01-01T00:10:00.000Z'),
    ]);
    expect(state.lanes[0].status).toBe('merged');
    expect(state.lanes[0].finishedAt).toBe('2026-01-01T00:10:00.000Z');
  });

  it.each(['fail', 'escalate', 'timeout', 'conflict', 'parked'])(
    '%s sets status failed with the phase active at failure and preserves the reason',
    type => {
      const state = reduceAll([
        ev('plan', '296', 'Starting plan phase'),
        ev('build', '296', 'Starting build phase (route: claude)'),
        ev(type, '296', 'boom', '2026-01-01T00:07:00.000Z'),
      ]);
      const lane = state.lanes[0];
      expect(lane.status).toBe('failed');
      expect(lane.failedPhase).toBe('BUILD');
      expect(lane.failReason).toBe('boom');
      expect(lane.finishedAt).toBe('2026-01-01T00:07:00.000Z');
    },
  );

  it('does not overwrite failedPhase/failReason when a second failure event follows', () => {
    const state = reduceAll([
      ev('plan', '296', 'Starting plan phase'),
      ev('fail', '296', 'first failure', '2026-01-01T00:07:00.000Z'),
      ev('parked', '296', 'lane parked', '2026-01-01T00:08:00.000Z'),
    ]);
    const lane = state.lanes[0];
    expect(lane.status).toBe('failed');
    expect(lane.failedPhase).toBe('PLAN');
    expect(lane.failReason).toBe('first failure');
    expect(lane.finishedAt).toBe('2026-01-01T00:08:00.000Z');
  });

  it('stopped sets status stopped and retains the last known run state', () => {
    const state = reduceAll([
      ev('plan', '296', 'Starting plan phase'),
      ev('build', '296', 'Starting build phase (route: claude)'),
      ev('stopped', '296', 'STOP flag present', '2026-01-01T00:09:00.000Z'),
    ]);
    const lane = state.lanes[0];
    expect(lane.status).toBe('stopped');
    expect(lane.finishedAt).toBe('2026-01-01T00:09:00.000Z');
    expect(lane.run.activePhase).toBe('BUILD');
  });

  it('resets a failed lane to running when a phase event arrives again (re-run)', () => {
    const state = reduceAll([
      ev('plan', '296', 'Starting plan phase'),
      ev('fail', '296', 'boom', '2026-01-01T00:07:00.000Z'),
      ev('plan', '296', 'Starting plan phase again', '2026-01-01T00:20:00.000Z'),
    ]);
    const lane = state.lanes[0];
    expect(lane.status).toBe('running');
    expect(lane.finishedAt).toBeUndefined();
    expect(lane.failedPhase).toBeUndefined();
    expect(lane.failReason).toBeUndefined();
    expect(lane.waitingSince).toBeUndefined();
  });

  it('resets a merged/ready/waiting-merge/stopped lane to running on a phase re-run', () => {
    for (const terminal of [
      ev('landed', '296', 'PR merged'),
      ev('ready', '296', 'PR #1 ready for review'),
      ev('await-merge', '296', 'waiting to merge x'),
      ev('stopped', '296', 'STOP flag present'),
    ]) {
      const state = reduceAll([ev('plan', '296', 'Starting plan phase'), terminal, ev('build', '296', 'again')]);
      expect(state.lanes[0].status).toBe('running');
    }
  });
});

describe('reduceDashboard — global events', () => {
  it('usage-stop sets usageStop without creating a lane', () => {
    const state = reduceDashboard(initialDashboard(), ev('usage-stop', 'usage', 'daily cap reached'));
    expect(state.usageStop).toBe('daily cap reached');
    expect(state.lanes).toHaveLength(0);
  });

  it('run-done sets runDone without creating a lane', () => {
    const state = reduceDashboard(initialDashboard(), ev('run-done', 'all', 'run complete'));
    expect(state.runDone).toBe(true);
    expect(state.lanes).toHaveLength(0);
  });

  it('non-lifecycle global events (triage, worktree-gc, watchdog, lane-done) create no lanes', () => {
    const state = reduceAll([
      ev('triage', '-', 'proposed queue updated'),
      ev('worktree-gc', 'all', 'swept 2 worktrees'),
      ev('watchdog', 'usage', 'usage check'),
      ev('lane-done', 'app', 'lane app finished'),
    ]);
    expect(state.lanes).toHaveLength(0);
    expect(state.usageStop).toBeUndefined();
    expect(state.runDone).toBe(false);
  });
});

describe('mergeTrainPosition', () => {
  it('orders waiting lanes by waitingSince, tiebreaking on issue number', () => {
    const state = reduceAll([
      ev('plan', '301', 'Starting plan phase'),
      ev('plan', '296', 'Starting plan phase'),
      ev('plan', '305', 'Starting plan phase'),
      ev('await-merge', '301', 'waiting', '2026-01-01T00:02:00.000Z'),
      ev('await-merge', '296', 'waiting', '2026-01-01T00:01:00.000Z'),
      ev('await-merge', '305', 'waiting', '2026-01-01T00:01:00.000Z'),
    ]);

    expect(mergeTrainPosition(state, '296')).toBe(1);
    expect(mergeTrainPosition(state, '305')).toBe(2);
    expect(mergeTrainPosition(state, '301')).toBe(3);
  });

  it('returns undefined for lanes not currently waiting-merge', () => {
    const state = reduceAll([ev('plan', '296', 'Starting plan phase')]);
    expect(mergeTrainPosition(state, '296')).toBeUndefined();
    expect(mergeTrainPosition(state, '999')).toBeUndefined();
  });
});

describe('laneElapsedMs', () => {
  it('measures against now while the lane is active', () => {
    const state = reduceAll([ev('plan', '296', 'Starting plan phase', '2026-01-01T00:00:00.000Z')]);
    const now = Date.parse('2026-01-01T00:00:05.000Z');
    expect(laneElapsedMs(state.lanes[0], now)).toBe(5000);
  });

  it('freezes at finishedAt once the lane is terminal', () => {
    const state = reduceAll([
      ev('plan', '296', 'Starting plan phase', '2026-01-01T00:00:00.000Z'),
      ev('landed', '296', 'PR merged', '2026-01-01T00:00:10.000Z'),
    ]);
    const now = Date.parse('2026-01-01T00:05:00.000Z');
    expect(laneElapsedMs(state.lanes[0], now)).toBe(10_000);
  });
});
