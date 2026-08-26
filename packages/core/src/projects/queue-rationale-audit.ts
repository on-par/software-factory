// packages/core/src/projects/queue-rationale-audit.ts — Local queue reprioritization audit records (#869).

import type { FactoryLogger } from '../logger/index.js';
import type { QueueReprioritizationRecord } from '../types/index.js';
import type { ProjectQueueProjection } from './project-queue-poller.js';

export interface QueueRationaleAuditor {
  observeAcceptedProjection(projection: ProjectQueueProjection): void;
  recordDaemonReprioritization(input: Omit<QueueReprioritizationRecord, 'actorType'>): void;
}

function logReprioritization(logger: FactoryLogger, record: QueueReprioritizationRecord): void {
  logger
    .child({ issue: record.issueNumber })
    .info('queue_reprioritized', `Queue order changed from ${record.priorValue} to ${record.newValue}`, {
      queueReprioritization: record,
    });
}

export function createQueueRationaleAuditor(logger: FactoryLogger): QueueRationaleAuditor {
  let priorProjection: ProjectQueueProjection | undefined;

  function observeAcceptedProjection(projection: ProjectQueueProjection): void {
    if (priorProjection !== undefined) {
      const priorItemsByIssueId = new Map(priorProjection.items.map((item) => [item.issue.id, item]));
      for (const item of projection.items) {
        const priorItem = priorItemsByIssueId.get(item.issue.id);
        if (priorItem === undefined || priorItem.order === item.order) continue;

        logReprioritization(logger, {
          issueId: item.issue.id,
          issueNumber: item.issue.number,
          field: 'order',
          priorValue: priorItem.order,
          newValue: item.order,
          actorType: 'human',
          rationale: null,
        });
      }
    }
    priorProjection = projection;
  }

  function recordDaemonReprioritization(input: Omit<QueueReprioritizationRecord, 'actorType'>): void {
    logReprioritization(logger, { ...input, actorType: 'daemon' });
  }

  return { observeAcceptedProjection, recordDaemonReprioritization };
}
