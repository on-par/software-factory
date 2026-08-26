import type { LaneLifecycleEvent } from '@on-par/contracts';
import { describe, expect, it } from 'vitest';

import { createReplayRing, formatSseFrame, parseLastEventId, type RepositoryLifecycleEvent } from './sse.js';

function makeEvent(overrides: Partial<LaneLifecycleEvent> = {}): LaneLifecycleEvent {
  return {
    ts: '2026-08-19T00:00:00.000Z',
    laneId: 'issue-1',
    issueId: '1',
    phase: 'build',
    status: 'started',
    detail: 'build started',
    worktreePath: '/tmp/worktree',
    ...overrides,
  };
}

function makeRepositoryEvent(overrides: Partial<LaneLifecycleEvent> = {}): RepositoryLifecycleEvent {
  return { ...makeEvent(overrides), repo: 'on-par/sound-buddy' };
}

describe('formatSseFrame', () => {
  it('produces the exact id/event/data/blank-line shape and round-trips through JSON.parse', () => {
    const event = makeRepositoryEvent();
    const frame = formatSseFrame(7, event);
    expect(frame).toBe(`id: 7\nevent: lifecycle\ndata: ${JSON.stringify(event)}\n\n`);
    const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
    expect(JSON.parse(dataLine!.slice('data: '.length))).toEqual(event);
  });
});

describe('parseLastEventId', () => {
  it.each([
    ['7', 7],
    ['0', 0],
    [undefined, undefined],
    [['1', '2'], undefined],
    ['', undefined],
    ['   ', undefined],
    ['abc', undefined],
    ['-1', undefined],
    ['1.5', undefined],
    [' 7 ', 7],
  ])('%p -> %p', (input, expected) => {
    expect(parseLastEventId(input)).toBe(expected);
  });
});

describe('createReplayRing', () => {
  it('retains entries in push order', () => {
    const ring = createReplayRing(5);
    ring.push(1, makeRepositoryEvent());
    ring.push(2, makeRepositoryEvent());
    expect(ring.since(0).map((e) => e.id)).toEqual([1, 2]);
  });

  it('evicts the oldest entry past capacity, keeping size at capacity', () => {
    const ring = createReplayRing(2);
    ring.push(1, makeRepositoryEvent());
    ring.push(2, makeRepositoryEvent());
    ring.push(3, makeRepositoryEvent());
    expect(ring.size).toBe(2);
    expect(ring.since(0).map((e) => e.id)).toEqual([2, 3]);
  });

  it('since(undefined) returns nothing', () => {
    const ring = createReplayRing(5);
    ring.push(1, makeRepositoryEvent());
    expect(ring.since(undefined)).toEqual([]);
  });

  it('since(0) returns everything retained', () => {
    const ring = createReplayRing(5);
    ring.push(1, makeRepositoryEvent());
    ring.push(2, makeRepositoryEvent());
    expect(ring.since(0).map((e) => e.id)).toEqual([1, 2]);
  });

  it('since(n) returns only ids greater than n', () => {
    const ring = createReplayRing(5);
    ring.push(1, makeRepositoryEvent());
    ring.push(2, makeRepositoryEvent());
    ring.push(3, makeRepositoryEvent());
    expect(ring.since(1).map((e) => e.id)).toEqual([2, 3]);
  });

  it('since(<huge>) returns nothing', () => {
    const ring = createReplayRing(5);
    ring.push(1, makeRepositoryEvent());
    expect(ring.since(1_000_000)).toEqual([]);
  });

  it('createReplayRing(0) clamps to capacity 1', () => {
    const ring = createReplayRing(0);
    ring.push(1, makeRepositoryEvent());
    ring.push(2, makeRepositoryEvent());
    expect(ring.size).toBe(1);
    expect(ring.since(0).map((e) => e.id)).toEqual([2]);
  });
});
