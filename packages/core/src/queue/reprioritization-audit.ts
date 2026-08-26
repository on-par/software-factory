// packages/core/src/queue/reprioritization-audit.ts — Local queue reprioritization audit records (#850).

import type { FactoryLogger } from '../logger/index.js';
import type { ProjectQueueProjection } from '../projects/project-queue-poller.js';
import type { QueueReprioritizationRecord } from '../types/index.js';

export interface QueueRationaleAuditor {
  observeAcceptedProjection(projection: ProjectQueueProjection): void;
  recordDaemonReprioritization(input: Omit<QueueReprioritizationRecord, 'actorType'>): void;
}

function logReprioritization(logger: FactoryLogger, record: QueueReprioritizationRecord): void {
  logger
    .child({ issue: record.issueNumber })
    .info('queue_reprioritized', `Queue ${record.field} changed from ${record.priorValue} to ${record.newValue}`, {
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
        if (priorItem === undefined) continue;

        const changedValues = [
          ['lane', priorItem.lane, item.lane],
          ['order', priorItem.order, item.order],
        ] as const;
        for (const [field, priorValue, newValue] of changedValues) {
          if (priorValue === newValue) continue;
          logReprioritization(logger, {
            issueId: item.issue.id,
            issueNumber: item.issue.number,
            field,
            priorValue,
            newValue,
            actorType: 'human',
            rationale: null,
          });
        }
      }
    }
    priorProjection = projection;
  }

  function recordDaemonReprioritization(input: Omit<QueueReprioritizationRecord, 'actorType'>): void {
    logReprioritization(logger, { ...input, actorType: 'daemon' });
  }

  return { observeAcceptedProjection, recordDaemonReprioritization };
}
