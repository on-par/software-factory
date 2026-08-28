import { describe, expect, it, vi } from 'vitest';

import type { LaneLifecycleEvent } from '@on-par/contracts';

import type { FactoryLogger } from '../logger/index.js';
import type { ProjectQueuePoller, ProjectQueueProjection } from '../projects/project-queue-poller.js';
import { createProjectStatusWriter } from '../projects/project-status-writer.js';
import {
  createProjectBoardStatusWriter,
  type ProjectBoardStatusConfig,
  type ProjectBoardStatusWriterOptions,
} from './project-board-status-writer.js';

const localOnlyMarkers = [
  'LOCAL_LIFECYCLE_MARKER',
  'LOCAL_COST_MARKER',
  'LOCAL_LOCK_MARKER',
  'LOCAL_BREAKER_MARKER',
] as const;

const board: ProjectBoardStatusConfig = {
  projectId: 'PVT_project',
  statusFieldId: 'PVTSSF_status',
  values: {
    readyOptionId: 'option-ready',
    inProgressOptionId: 'option-active',
    blockedOptionId: 'option-blocked',
    doneOptionId: 'option-done',
  },
};

const projection: ProjectQueueProjection = {
  refreshedAt: '2026-08-25T12:00:00.000Z',
  items: [
    {
      membership: { projectId: board.projectId, itemId: 'PVTI_42' },
      issue: { id: 'I_42', number: 42 },
      lane: 'Build',
      order: 1,
      status: 'ready',
    },
  ],
  diagnostics: [],
};

function createLogger(): FactoryLogger {
  const logger: FactoryLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return logger;
}

describe('ProjectV2 status write boundary', () => {
  it('projects lifecycle events to a coarse status without local operational state', async () => {
    const graphql = vi.fn<ProjectBoardStatusWriterOptions['graphql']>(async () => ({}));
    const boardWriter = createProjectBoardStatusWriter({ boards: [board], graphql, logger: createLogger() });
    const projectionSource: Pick<ProjectQueuePoller, 'snapshot'> = { snapshot: () => projection };
    const statusWriter = createProjectStatusWriter({ projectionSource, boardWriter });
    const event: LaneLifecycleEvent = {
      ts: '2026-08-25T12:00:00.000Z',
      laneId: 'issue-42',
      issueId: '42',
      phase: 'plan',
      status: 'started',
      detail: localOnlyMarkers.join(' | '),
      worktreePath: `/tmp/${localOnlyMarkers.join('-')}`,
    };

    await statusWriter.handle(event);

    expect(graphql).toHaveBeenCalledOnce();
    const [mutation, variables] = graphql.mock.calls[0]!;
    expect(variables).toEqual({
      projectId: board.projectId,
      itemId: 'PVTI_42',
      fieldId: board.statusFieldId,
      value: { singleSelectOptionId: board.values.inProgressOptionId },
    });
    const serializedMutation = JSON.stringify({ mutation, variables });
    for (const marker of localOnlyMarkers) expect(serializedMutation).not.toContain(marker);
  });
});
