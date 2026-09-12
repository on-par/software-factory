import { describe, expect, it } from 'vitest';

import { emptyLaneBoard, reduceLaneEvent, type LaneCard } from './laneBoardState.js';
import { STALE_AFTER_MS, formatElapsed, laneProgress } from './laneProgress.js';

function cardFromEvents(events: Parameters<typeof reduceLaneEvent>[1][]): LaneCard {
  let state = emptyLaneBoard();
  for (const event of events) state = reduceLaneEvent(state, event);
  return state.lanes[0] as LaneCard;
}

const T0 = Date.parse('2026-08-19T00:00:00.000Z');

describe('formatElapsed', () => {
  it('clamps negative durations to 0s', () => {
    expect(formatElapsed(-500)).toBe('0s');
  });

  it('renders sub-minute durations as seconds', () => {
    expect(formatElapsed(12_000)).toBe('12s');
  });

  it('renders sub-hour durations as minutes and padded seconds', () => {
    expect(formatElapsed(3 * 60_000 + 5_000)).toBe('3m 05s');
  });

  it('renders hour-plus durations as hours and padded minutes', () => {
    expect(formatElapsed(60 * 60_000 + 2 * 60_000)).toBe('1h 02m');
  });
});

describe('laneProgress', () => {
  it('renders the active state with a phase-in-progress label', () => {
    const card = cardFromEvents([
      {
        ts: '2026-08-19T00:00:00.000Z',
        laneId: 'l',
        issueId: '1',
        phase: 'build',
        status: 'started',
        detail: 'go',
        worktreePath: '/tmp/l',
      },
    ]);
    const progress = laneProgress(card, T0 + 10_000);
    expect(progress.state).toBe('active');
    expect(progress.label).toBe('build…');
  });

  it('renders a done non-ship phase as "<phase> done" and still active', () => {
    const card = cardFromEvents([
      {
        ts: '2026-08-19T00:00:00.000Z',
        laneId: 'l',
        issueId: '1',
        phase: 'check',
        status: 'done',
        detail: 'ok',
        worktreePath: '/tmp/l',
      },
    ]);
    const progress = laneProgress(card, T0 + 10_000);
    expect(progress.state).toBe('active');
    expect(progress.label).toBe('check done');
  });

  it('renders shipped when ship is done', () => {
    const card = cardFromEvents([
      {
        ts: '2026-08-19T00:00:00.000Z',
        laneId: 'l',
        issueId: '1',
        phase: 'ship',
        status: 'done',
        detail: 'shipped',
        worktreePath: '/tmp/l',
      },
    ]);
    const progress = laneProgress(card, T0 + 10_000);
    expect(progress.state).toBe('shipped');
    expect(progress.label).toBe('shipped');
  });

  it('renders failed when status is failed, regardless of laneState', () => {
    const card = cardFromEvents([
      {
        ts: '2026-08-19T00:00:00.000Z',
        laneId: 'l',
        issueId: '1',
        phase: 'check',
        status: 'failed',
        detail: 'boom',
        worktreePath: '/tmp/l',
      },
    ]);
    const progress = laneProgress(card, T0 + 10_000);
    expect(progress.state).toBe('failed');
    expect(progress.label).toBe('failed');
  });

  it('AC 1: a waiting-merge lane with a fresh heartbeat is waiting-merge, not stale, with a non-empty elapsed label', () => {
    const card = cardFromEvents([
      {
        ts: '2026-08-19T00:00:00.000Z',
        laneId: 'l',
        issueId: '1',
        phase: 'ship',
        status: 'progress',
        detail: 'waiting for merge',
        worktreePath: '/tmp/l',
        laneState: 'waiting-merge',
      },
    ]);
    const progress = laneProgress(card, T0 + 10_000);
    expect(progress.state).toBe('waiting-merge');
    expect(progress.label).toBe('waiting-merge');
    expect(progress.elapsedLabel).not.toBe('');
  });

  it('AC 1: the same waiting-merge lane goes stale once its last frame exceeds STALE_AFTER_MS', () => {
    const card = cardFromEvents([
      {
        ts: '2026-08-19T00:00:00.000Z',
        laneId: 'l',
        issueId: '1',
        phase: 'ship',
        status: 'progress',
        detail: 'waiting for merge',
        worktreePath: '/tmp/l',
        laneState: 'waiting-merge',
      },
    ]);
    const progress = laneProgress(card, T0 + STALE_AFTER_MS + 60_000);
    expect(progress.state).toBe('stale');
    expect(progress.label).toBe('stale');
  });

  it('renders a non-terminal lane with an old last frame as stale', () => {
    const card = cardFromEvents([
      {
        ts: '2026-08-19T00:00:00.000Z',
        laneId: 'l',
        issueId: '1',
        phase: 'build',
        status: 'progress',
        detail: 'go',
        worktreePath: '/tmp/l',
      },
    ]);
    const progress = laneProgress(card, T0 + STALE_AFTER_MS + 1);
    expect(progress.state).toBe('stale');
  });

  it('AC 2: a parked lane exposes parkReason and nextAction with the worktree path, never stale even at 1h old', () => {
    const card = cardFromEvents([
      {
        ts: '2026-08-19T00:00:00.000Z',
        laneId: 'l',
        issueId: '1',
        phase: 'build',
        status: 'progress',
        detail: 'needs human review',
        worktreePath: '/tmp/lane-parked',
        laneState: 'parked',
      },
    ]);
    const progress = laneProgress(card, T0 + 60 * 60_000);
    expect(progress.state).toBe('parked');
    expect(progress.parkReason).toBe('needs human review');
    expect(progress.nextAction?.href).toContain('/tmp/lane-parked');
  });

  it('freezes lane elapsedLabel at the last frame once the lane is terminal', () => {
    const card = cardFromEvents([
      {
        ts: '2026-08-19T00:00:00.000Z',
        laneId: 'l',
        issueId: '1',
        phase: 'ship',
        status: 'done',
        detail: 'shipped',
        worktreePath: '/tmp/l',
      },
    ]);
    const atShip = laneProgress(card, T0);
    const muchLater = laneProgress(card, T0 + 60 * 60_000);
    expect(atShip.elapsedLabel).toBe(muchLater.elapsedLabel);
  });

  it('keeps per-phase elapsed live for the active phase and frozen for a finished one', () => {
    const card = cardFromEvents([
      {
        ts: '2026-08-19T00:00:00.000Z',
        laneId: 'l',
        issueId: '1',
        phase: 'plan',
        status: 'started',
        detail: 'go',
        worktreePath: '/tmp/l',
      },
      {
        ts: '2026-08-19T00:01:00.000Z',
        laneId: 'l',
        issueId: '1',
        phase: 'plan',
        status: 'done',
        detail: 'done',
        worktreePath: '/tmp/l',
      },
      {
        ts: '2026-08-19T00:01:00.000Z',
        laneId: 'l',
        issueId: '1',
        phase: 'build',
        status: 'started',
        detail: 'go',
        worktreePath: '/tmp/l',
      },
    ]);
    const progress = laneProgress(card, T0 + 5 * 60_000);
    const plan = progress.phases.find((p) => p.phase === 'plan');
    const build = progress.phases.find((p) => p.phase === 'build');
    expect(plan?.elapsedLabel).toBe('1m 00s');
    expect(build?.elapsedLabel).toBe('4m 00s');
  });

  it('leaves elapsedLabel undefined for a pending phase', () => {
    const card = cardFromEvents([
      {
        ts: '2026-08-19T00:00:00.000Z',
        laneId: 'l',
        issueId: '1',
        phase: 'plan',
        status: 'started',
        detail: 'go',
        worktreePath: '/tmp/l',
      },
    ]);
    const progress = laneProgress(card, T0);
    expect(progress.phases.find((p) => p.phase === 'ship')?.elapsedLabel).toBeUndefined();
  });
});
