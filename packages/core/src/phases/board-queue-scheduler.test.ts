import { describe, expect, it, vi } from 'vitest';

import type { ProjectQueueProjection } from '../projects/project-queue-poller.js';
import type { ProjectQueueIntentItem } from '../projects/project-queue-reader.js';
import { createBoardQueueScheduler, type ProjectQueueProjectionReader } from './board-queue-scheduler.js';

function queueItem(
  issueNumber: number,
  overrides: Partial<Pick<ProjectQueueIntentItem, 'lane' | 'order' | 'status'>> = {},
): ProjectQueueIntentItem {
  return {
    membership: { projectId: 'PVT_1', itemId: `PVTI_${issueNumber}` },
    issue: { id: `I_${issueNumber}`, number: issueNumber },
    lane: 'build',
    order: issueNumber,
    status: 'ready',
    ...overrides,
  };
}

function projection(...items: ProjectQueueIntentItem[]): ProjectQueueProjection {
  return { refreshedAt: '2026-08-25T00:00:00.000Z', items, diagnostics: [] };
}

function mutableReader(initial: ProjectQueueProjection | null) {
  let current = initial;
  const reader: ProjectQueueProjectionReader = { snapshot: vi.fn(() => current) };
  return {
    reader,
    setSnapshot(next: ProjectQueueProjection | null) {
      current = next;
    },
  };
}

describe('createBoardQueueScheduler', () => {
  it('fails closed without a projection, groups original local candidates, and observes lane refreshes', () => {
    const first = Object.freeze({ issueNumber: 1, localState: 'first' });
    const second = Object.freeze({ issueNumber: 2, localState: 'second' });
    const { reader, setSnapshot } = mutableReader(null);
    const scheduler = createBoardQueueScheduler({ projectionReader: reader, dispatchableStatuses: ['ready'] });

    expect(scheduler.select([first, second])).toEqual(new Map());

    setSnapshot(projection(queueItem(1, { lane: 'build' }), queueItem(2, { lane: 'check' })));
    expect(scheduler.select([second, first])).toEqual(
      new Map([
        ['check', [second]],
        ['build', [first]],
      ]),
    );
    expect(scheduler.select([first]).get('build')?.[0]).toBe(first);

    setSnapshot(projection(queueItem(1, { lane: 'ship' }), queueItem(2, { lane: 'check' })));
    expect(scheduler.select([first, second])).toEqual(
      new Map([
        ['ship', [first]],
        ['check', [second]],
      ]),
    );
    expect(reader.snapshot).toHaveBeenCalledTimes(4);
  });

  it('orders each lane by projected order and observes reordered projections', () => {
    const first = { issueNumber: 1 };
    const second = { issueNumber: 2 };
    const third = { issueNumber: 3 };
    const { reader, setSnapshot } = mutableReader(
      projection(queueItem(1, { order: 3 }), queueItem(2, { order: 1 }), queueItem(3, { order: 1 })),
    );
    const scheduler = createBoardQueueScheduler({ projectionReader: reader, dispatchableStatuses: ['ready'] });

    expect(scheduler.select([first, third, second]).get('build')).toEqual([second, third, first]);

    setSnapshot(projection(queueItem(1, { order: 1 }), queueItem(2, { order: 3 }), queueItem(3, { order: 2 })));
    expect(scheduler.select([second, third, first]).get('build')).toEqual([first, third, second]);

    setSnapshot(projection(queueItem(1, { order: 'P2' }), queueItem(2, { order: 'P1' })));
    expect(scheduler.select([first, second]).get('build')).toEqual([second, first]);
  });

  it('excludes non-members and statuses outside daemon policy, including done', () => {
    const candidates = [1, 2, 3, 4, 5].map((issueNumber) => ({ issueNumber }));
    const { reader } = mutableReader(
      projection(
        queueItem(1, { status: 'ready' }),
        queueItem(2, { status: 'in_progress' }),
        queueItem(3, { status: 'blocked' }),
        queueItem(4, { status: 'done' }),
      ),
    );
    const scheduler = createBoardQueueScheduler({
      projectionReader: reader,
      dispatchableStatuses: ['ready', 'in_progress'],
    });

    expect(scheduler.select(candidates).get('build')).toEqual([candidates[0], candidates[1]]);

    const doneScheduler = createBoardQueueScheduler({ projectionReader: reader, dispatchableStatuses: ['done'] });
    expect(doneScheduler.select(candidates).get('build')).toEqual([candidates[3]]);
  });
});
