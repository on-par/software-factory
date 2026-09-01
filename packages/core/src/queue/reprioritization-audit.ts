// packages/core/src/queue/reprioritization-audit.ts — Local queue reprioritization audit records (#850),
// plus durable rationale comments posted back to the issue (#1049).

import type { FactoryLogger } from '../logger/index.js';
import type { ProjectQueueProjection } from '../projects/project-queue-poller.js';
import type { QueueReprioritizationRecord } from '../types/index.js';

export interface QueueRationaleCommentClient {
  commentOnIssue(input: { issueNumber: number; body: string }): Promise<void>;
}

export interface QueueRationaleAuditorOptions {
  readonly commentClient?: QueueRationaleCommentClient;
}

export interface QueueRationaleAuditor {
  observeAcceptedProjection(projection: ProjectQueueProjection): Promise<void>;
  recordDaemonReprioritization(input: Omit<QueueReprioritizationRecord, 'actorType'>): Promise<void>;
}

export function renderReprioritizationComment(record: QueueReprioritizationRecord): string {
  const lines = [
    '🗂️ **Queue reprioritization recorded**',
    '',
    `- **Field:** ${record.field}`,
    `- **Previous:** ${record.priorValue}`,
    `- **New:** ${record.newValue}`,
    `- **Actor:** ${record.actorType}`,
  ];
  if (record.rationale !== null) lines.push(`- **Rationale:** ${record.rationale}`);
  return lines.join('\n');
}

function logReprioritization(logger: FactoryLogger, record: QueueReprioritizationRecord): void {
  logger
    .child({ issue: record.issueNumber })
    .info('queue_reprioritized', `Queue ${record.field} changed from ${record.priorValue} to ${record.newValue}`, {
      queueReprioritization: record,
    });
}

export function createQueueRationaleAuditor(
  logger: FactoryLogger,
  options?: QueueRationaleAuditorOptions,
): QueueRationaleAuditor {
  let priorProjection: ProjectQueueProjection | undefined;

  async function emit(record: QueueReprioritizationRecord): Promise<void> {
    logReprioritization(logger, record);

    if (options?.commentClient === undefined) return;
    try {
      await options.commentClient.commentOnIssue({
        issueNumber: record.issueNumber,
        body: renderReprioritizationComment(record),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger
        .child({ issue: record.issueNumber })
        .warn('queue_rationale_comment_failed', `Queue rationale comment failed: ${message}`, {
          queueReprioritization: record,
        });
    }
  }

  async function observeAcceptedProjection(projection: ProjectQueueProjection): Promise<void> {
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
          await emit({
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

  async function recordDaemonReprioritization(input: Omit<QueueReprioritizationRecord, 'actorType'>): Promise<void> {
    await emit({ ...input, actorType: 'daemon' });
  }

  return { observeAcceptedProjection, recordDaemonReprioritization };
}
