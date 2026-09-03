// packages/core/src/projects/project-status-writer.ts — Coarse daemon status publishing for ProjectV2 items (#868).

import type { LaneLifecycleEvent } from '@on-par/contracts';

import type { ProjectBoardCoarseStatus, ProjectBoardStatusWriter } from '../queue/project-board-status-writer.js';
import type { ProjectQueuePoller } from './project-queue-poller.js';
import type { ProjectQueueStatus } from './project-queue-reader.js';

export interface ProjectStatusWriterOptions {
  readonly projectionSource: Pick<ProjectQueuePoller, 'snapshot'>;
  readonly boardWriter: ProjectBoardStatusWriter;
}

export interface ProjectStatusWriter {
  handle(event: LaneLifecycleEvent): Promise<void>;
}

const COARSE_BY_QUEUE_STATUS: Partial<Record<ProjectQueueStatus, ProjectBoardCoarseStatus>> = {
  ready: 'ready',
  in_progress: 'active',
  blocked: 'blocked',
  done: 'done',
};

function coarseStatus(event: LaneLifecycleEvent): ProjectBoardCoarseStatus | null {
  if (event.phase === 'plan' && event.status === 'started') return 'active';
  if (event.phase === 'ship' && event.status === 'done') return 'done';
  return null;
}

function issueNumber(issueId: string): number | null {
  if (!/^\d+$/.test(issueId)) return null;
  const number = Number(issueId);
  return Number.isSafeInteger(number) ? number : null;
}

export function createProjectStatusWriter(options: ProjectStatusWriterOptions): ProjectStatusWriter {
  const lastWritten = new Map<string, ProjectBoardCoarseStatus>();

  async function handle(event: LaneLifecycleEvent): Promise<void> {
    const status = coarseStatus(event);
    if (status === null) return;

    const number = issueNumber(event.issueId);
    if (number === null) return;

    const projection = options.projectionSource.snapshot();
    const item = projection?.items.find((candidate) => candidate.issue.number === number);
    if (item === undefined) return;

    const known = lastWritten.get(item.membership.itemId) ?? COARSE_BY_QUEUE_STATUS[item.status];
    if (known === status) return;

    await options.boardWriter.write(item.membership, status);
    lastWritten.set(item.membership.itemId, status);
  }

  return { handle };
}
