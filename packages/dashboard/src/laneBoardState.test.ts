import type { LaneLifecycleEvent, LaneLifecyclePhase, LaneLifecycleStatus } from '@on-par/factory-core';
import { describe, expect, it } from 'vitest';

import { LOG_TAIL_LIMIT, emptyLaneBoard, laneChipLabel, reduceLaneEvent, type LaneCard } from './laneBoardState.js';

function makeEvent(overrides: Partial<LaneLifecycleEvent> = {}): LaneLifecycleEvent {
  return {
    ts: '2026-08-19T00:00:00.000Z',
    laneId: 'lane-1',
    issueId: '593',
    phase: 'plan',
    status: 'started',
    detail: 'planning',
    worktreePath: '/tmp/lane-1',
    ...overrides,
  };
}

describe('emptyLaneBoard', () => {
  it('returns a lane-free board', () => {
    expect(emptyLaneBoard()).toEqual({ lanes: [] });
  });
});

describe('reduceLaneEvent', () => {
  it('inserts a card for an unseen laneId, with only the event phase non-pending', () => {
    const state = reduceLaneEvent(emptyLaneBoard(), makeEvent());
    expect(state.lanes).toHaveLength(1);
    const card = state.lanes[0] as LaneCard;
    expect(card.laneId).toBe('lane-1');
    expect(card.issueId).toBe('593');
    expect(card.worktreePath).toBe('/tmp/lane-1');
    expect(card.detail).toBe('planning');
    expect(card.segments).toEqual({ plan: 'active', build: 'pending', check: 'pending', ship: 'pending' });
  });

  it('updates an existing lane in place rather than adding a second card', () => {
    let state = reduceLaneEvent(emptyLaneBoard(), makeEvent());
    state = reduceLaneEvent(state, makeEvent({ status: 'progress', detail: 'still planning' }));
    expect(state.lanes).toHaveLength(1);
    expect(state.lanes[0]?.detail).toBe('still planning');
  });

  it('keeps lanes sorted by laneId regardless of arrival order', () => {
    let state = reduceLaneEvent(emptyLaneBoard(), makeEvent({ laneId: 'lane-b' }));
    state = reduceLaneEvent(state, makeEvent({ laneId: 'lane-a' }));
    expect(state.lanes.map((lane) => lane.laneId)).toEqual(['lane-a', 'lane-b']);
  });

  const statusToSegment: Array<[LaneLifecycleStatus, string]> = [
    ['started', 'active'],
    ['progress', 'active'],
    ['done', 'done'],
    ['failed', 'failed'],
  ];

  it.each(statusToSegment)('maps status %s to segment state %s', (status, expected) => {
    const state = reduceLaneEvent(emptyLaneBoard(), makeEvent({ status }));
    expect(state.lanes[0]?.segments.plan).toBe(expected);
  });

  it('does not back-fill an earlier phase that was never observed', () => {
    const state = reduceLaneEvent(emptyLaneBoard(), makeEvent({ phase: 'build', status: 'started' }));
    expect(state.lanes[0]?.segments.plan).toBe('pending');
    expect(state.lanes[0]?.segments.build).toBe('active');
  });

  it('caps the log tail at LOG_TAIL_LIMIT and keeps the newest entries last', () => {
    let state = emptyLaneBoard();
    for (let i = 0; i < 25; i += 1) {
      state = reduceLaneEvent(state, makeEvent({ detail: `line-${i}` }));
    }
    const log = state.lanes[0]?.log ?? [];
    expect(log).toHaveLength(LOG_TAIL_LIMIT);
    expect(log.at(-1)?.detail).toBe('line-24');
  });

  it('does not mutate the previous state', () => {
    const previous = reduceLaneEvent(emptyLaneBoard(), makeEvent());
    const previousLanesRef = previous.lanes;
    const previousCardRef = previous.lanes[0];
    const previousCardSnapshot = JSON.parse(JSON.stringify(previousCardRef));

    reduceLaneEvent(previous, makeEvent({ status: 'progress', detail: 'changed' }));

    expect(previous.lanes).toBe(previousLanesRef);
    expect(previous.lanes[0]).toBe(previousCardRef);
    expect(previous.lanes[0]).toEqual(previousCardSnapshot);
  });
});

describe('laneChipLabel', () => {
  const phase: LaneLifecyclePhase = 'build';

  it.each([
    ['started', 'BUILD · running'],
    ['progress', 'BUILD · running'],
    ['done', 'BUILD · done'],
    ['failed', 'BUILD · failed'],
  ] as const)('formats status %s as %s', (status, expected) => {
    const state = reduceLaneEvent(emptyLaneBoard(), makeEvent({ phase, status }));
    const card = state.lanes[0] as LaneCard;
    expect(laneChipLabel(card)).toBe(expected);
  });
});
