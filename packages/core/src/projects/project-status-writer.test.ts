import { describe, expect, it, vi } from 'vitest';

import type { LaneLifecycleEvent } from '@on-par/contracts';

import type { ProjectBoardStatusWriter } from '../queue/project-board-status-writer.js';
import type { ProjectQueuePoller, ProjectQueueProjection } from './project-queue-poller.js';
import { createProjectStatusWriter } from './project-status-writer.js';

const membership = { projectId: 'PVT_project', itemId: 'PVTI_42' };

function projection(): ProjectQueueProjection {
  return {
    refreshedAt: '2026-08-25T12:00:00.000Z',
    items: [
      {
        membership,
        issue: { id: 'I_42', number: 42 },
        lane: 'Build',
        order: 1,
        status: 'ready',
      },
      {
        membership: { projectId: 'PVT_other', itemId: 'PVTI_43' },
        issue: { id: 'I_43', number: 43 },
        lane: 'Ship',
        order: 2,
        status: 'in_progress',
      },
    ],
    diagnostics: [],
  };
}

function lifecycleEvent(overrides: Partial<LaneLifecycleEvent> = {}): LaneLifecycleEvent {
  return {
    ts: '2026-08-25T12:00:00.000Z',
    laneId: 'issue-42',
    issueId: '42',
    phase: 'plan',
    status: 'started',
    detail: 'plan started with sensitive lifecycle detail',
    worktreePath: '/tmp/issue-42',
    ...overrides,
  };
}

function createWriter(snapshot: ProjectQueueProjection | null = projection()) {
  const write = vi.fn(async () => {});
  const projectionSource: Pick<ProjectQueuePoller, 'snapshot'> = { snapshot: () => snapshot };
  const boardWriter: ProjectBoardStatusWriter = { write };
  return { writer: createProjectStatusWriter({ projectionSource, boardWriter }), write };
}

describe('createProjectStatusWriter', () => {
  it('writes active for the exact ProjectV2 membership when PLAN starts', async () => {
    const { writer, write } = createWriter();

    await writer.handle(lifecycleEvent());

    expect(write.mock.calls).toEqual([[membership, 'active']]);
  });

  it('writes done for the exact ProjectV2 membership when SHIP completes', async () => {
    const { writer, write } = createWriter();

    await writer.handle(lifecycleEvent({ phase: 'ship', status: 'done' }));

    expect(write.mock.calls).toEqual([[membership, 'done']]);
  });

  it.each([
    { phase: 'plan', status: 'progress' },
    { phase: 'plan', status: 'done' },
    { phase: 'plan', status: 'failed' },
    { phase: 'build', status: 'started' },
    { phase: 'build', status: 'progress' },
    { phase: 'build', status: 'done' },
    { phase: 'build', status: 'failed' },
    { phase: 'check', status: 'started' },
    { phase: 'check', status: 'progress' },
    { phase: 'check', status: 'done' },
    { phase: 'check', status: 'failed' },
    { phase: 'ship', status: 'started' },
    { phase: 'ship', status: 'progress' },
    { phase: 'ship', status: 'failed' },
  ] as const)('does not write for $phase $status lifecycle detail', async (event) => {
    const { writer, write } = createWriter();

    await writer.handle(lifecycleEvent(event));

    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ['unavailable projection', null, lifecycleEvent()],
    ['unassociated issue', projection(), lifecycleEvent({ issueId: '999' })],
    ['nonnumeric issue ID', projection(), lifecycleEvent({ issueId: 'issue-42' })],
    ['unsafe numeric issue ID', projection(), lifecycleEvent({ issueId: '9007199254740992' })],
  ] as const)('does not write for %s', async (_description, snapshot, event) => {
    const { writer, write } = createWriter(snapshot);

    await writer.handle(event);

    expect(write).not.toHaveBeenCalled();
  });
});
