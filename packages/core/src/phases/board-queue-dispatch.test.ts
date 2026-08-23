import { describe, expect, it, vi } from 'vitest';

import type { QueueIntentItem, QueueIntentSnapshot, QueueIntentStatus } from '../queue/project-board-poller.js';
import { createBoardQueueDispatcher, type LocalLaneCandidate, type QueueIntentReader } from './board-queue-dispatch.js';

function queueItem(
  issueNumber: number | null,
  overrides: Partial<Pick<QueueIntentItem, 'lane' | 'priority' | 'status'>> = {},
): QueueIntentItem {
  return {
    projectId: 'PVT_1',
    itemId: `PVTI_${issueNumber ?? 'draft'}`,
    issueId: issueNumber === null ? null : `I_${issueNumber}`,
    issueNumber,
    lane: 'build',
    priority: null,
    status: 'queued',
    ...overrides,
  };
}

function snapshot(...items: QueueIntentItem[]): QueueIntentSnapshot {
  return { refreshedAt: '2026-08-23T00:00:00.000Z', items };
}

function mutableReader(initial: QueueIntentSnapshot | null) {
  let current = initial;
  const reader: QueueIntentReader = { snapshot: vi.fn(() => current) };
  return {
    reader,
    setSnapshot(next: QueueIntentSnapshot | null) {
      current = next;
    },
  };
}

describe('createBoardQueueDispatcher', () => {
  it('returns the board-ranked original local candidate, not a board-derived record', () => {
    const first = { issueNumber: 1, localState: 'first' };
    const second = { issueNumber: 2, localState: 'second' };
    const { reader } = mutableReader(snapshot(queueItem(2), queueItem(1)));
    const dispatcher = createBoardQueueDispatcher(reader, { kind: 'board' });

    const selected = dispatcher.next('build', [first, second]);

    expect(selected).toBe(second);
    expect(selected).toMatchObject({ localState: 'second' });
  });

  it('excludes non-members, other lanes, non-queued statuses, and items without issues', () => {
    const excluded: Array<LocalLaneCandidate> = [
      { issueNumber: 1 },
      { issueNumber: 2 },
      { issueNumber: 3 },
      { issueNumber: 4 },
      { issueNumber: 5 },
      { issueNumber: 6 },
    ];
    const eligible = { issueNumber: 7, localState: 'eligible' };
    const { reader } = mutableReader(
      snapshot(
        queueItem(null),
        queueItem(2, { lane: 'check' }),
        queueItem(3, { status: 'active' }),
        queueItem(4, { status: 'blocked' }),
        queueItem(5, { status: 'done' }),
        queueItem(6, { status: 'unknown' as QueueIntentStatus }),
        queueItem(7),
      ),
    );
    const dispatcher = createBoardQueueDispatcher(reader, { kind: 'board' });

    expect(dispatcher.next('build', [...excluded, eligible])).toBe(eligible);
  });

  it('fails closed without a snapshot and observes membership and lane edits on every selection', () => {
    const first = { issueNumber: 1 };
    const second = { issueNumber: 2 };
    const { reader, setSnapshot } = mutableReader(null);
    const snapshotReader = reader.snapshot as ReturnType<typeof vi.fn>;
    const dispatcher = createBoardQueueDispatcher(reader, { kind: 'board' });

    expect(dispatcher.next('build', [first, second])).toBeNull();

    setSnapshot(snapshot(queueItem(1)));
    expect(dispatcher.next('build', [second, first])).toBe(first);

    setSnapshot(snapshot(queueItem(1, { lane: 'check' }), queueItem(2)));
    expect(dispatcher.next('build', [first, second])).toBe(second);
    expect(snapshotReader).toHaveBeenCalledTimes(3);
  });

  it('observes status edits immediately', () => {
    const candidate = { issueNumber: 1 };
    const { reader, setSnapshot } = mutableReader(snapshot(queueItem(1)));
    const dispatcher = createBoardQueueDispatcher(reader, { kind: 'board' });

    expect(dispatcher.next('build', [candidate])).toBe(candidate);
    setSnapshot(snapshot(queueItem(1, { status: 'done' })));
    expect(dispatcher.next('build', [candidate])).toBeNull();
  });

  it('ranks configured priorities highest-to-lowest and uses board order for priority ties', () => {
    const first = { issueNumber: 1 };
    const second = { issueNumber: 2 };
    const third = { issueNumber: 3 };
    const { reader } = mutableReader(
      snapshot(queueItem(1, { priority: 'P1' }), queueItem(2, { priority: 'P0' }), queueItem(3, { priority: 'P0' })),
    );
    const dispatcher = createBoardQueueDispatcher(reader, { kind: 'priority', priorityValues: ['P0', 'P1'] });

    expect(dispatcher.next('build', [third, first, second])).toBe(second);
    expect(dispatcher.next('build', [third, first])).toBe(third);
  });

  it('uses board order for equal, absent, and unconfigured priority values', () => {
    const unconfigured = { issueNumber: 1 };
    const absent = { issueNumber: 2 };
    const anotherUnconfigured = { issueNumber: 3 };
    const { reader } = mutableReader(
      snapshot(queueItem(1, { priority: 'Routine' }), queueItem(2), queueItem(3, { priority: 'Routine' })),
    );
    const dispatcher = createBoardQueueDispatcher(reader, { kind: 'priority', priorityValues: ['P0', 'P1'] });

    expect(dispatcher.next('build', [anotherUnconfigured, absent, unconfigured])).toBe(unconfigured);
  });

  it('observes priority edits immediately without accessing a board write or lifecycle port', () => {
    const first = Object.freeze({ issueNumber: 1, localState: 'first' });
    const second = Object.freeze({ issueNumber: 2, localState: 'second' });
    const { reader, setSnapshot } = mutableReader(
      snapshot(queueItem(1, { priority: 'P1' }), queueItem(2, { priority: 'P0' })),
    );
    const dispatcher = createBoardQueueDispatcher(reader, { kind: 'priority', priorityValues: ['P0', 'P1'] });

    expect(dispatcher.next('build', [first, second])).toBe(second);
    setSnapshot(snapshot(queueItem(1, { priority: 'P0' }), queueItem(2, { priority: 'P1' })));
    expect(dispatcher.next('build', [second, first])).toBe(first);
    expect(Object.keys(reader)).toEqual(['snapshot']);
  });
});
