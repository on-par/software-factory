// packages/core/src/queue/project-board-poller.ts — ProjectV2 queue-intent snapshot types (#847); the poller itself was removed (#3782).

export type QueueIntentStatus = 'queued' | 'active' | 'blocked' | 'done' | 'unknown';

export interface QueueIntentItem {
  readonly projectId: string;
  readonly itemId: string;
  readonly issueId: string | null;
  readonly issueNumber: number | null;
  readonly lane: string | null;
  readonly priority: string | number | null;
  readonly status: QueueIntentStatus;
}

export interface QueueIntentSnapshot {
  readonly refreshedAt: string;
  readonly items: readonly QueueIntentItem[];
}
