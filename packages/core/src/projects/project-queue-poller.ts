// packages/core/src/projects/project-queue-poller.ts — Daemon-ready ProjectV2 queue-intent projection (#866).

import type { FactoryLogger } from '../logger/index.js';
import type { QueueReprioritizationRecord } from '../types/index.js';
import { createQueueRationaleAuditor } from '../queue/reprioritization-audit.js';
import type { QueueRationaleCommentClient } from '../queue/reprioritization-audit.js';
import type { ProjectQueueIntentItem, ProjectQueueReadDiagnostic, ProjectQueueReader } from './project-queue-reader.js';

export const DEFAULT_PROJECT_QUEUE_POLL_MS = 30_000;

export interface ProjectQueueProjection {
  readonly refreshedAt: string;
  readonly items: readonly ProjectQueueIntentItem[];
  readonly diagnostics: readonly ProjectQueueReadDiagnostic[];
}

export interface ProjectQueuePollerOptions {
  readonly reader: ProjectQueueReader;
  readonly logger: FactoryLogger;
  readonly pollMs?: number;
  readonly commentClient?: QueueRationaleCommentClient;
}

export interface ProjectQueuePoller {
  start(): Promise<void>;
  stop(): void;
  pollNow(): Promise<ProjectQueueProjection | null>;
  snapshot(): ProjectQueueProjection | null;
  recordDaemonReprioritization(input: Omit<QueueReprioritizationRecord, 'actorType'>): Promise<void>;
}

function copyProjection(projection: ProjectQueueProjection | null): ProjectQueueProjection | null {
  if (projection === null) return null;
  return {
    refreshedAt: projection.refreshedAt,
    items: projection.items.map((item) => ({
      membership: { ...item.membership },
      issue: { ...item.issue },
      lane: item.lane,
      order: item.order,
      status: item.status,
    })),
    diagnostics: projection.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  };
}

function projectionFromRead(result: {
  readonly items: readonly ProjectQueueIntentItem[];
  readonly diagnostics: readonly ProjectQueueReadDiagnostic[];
}): ProjectQueueProjection {
  return {
    refreshedAt: new Date().toISOString(),
    items: result.items.map((item) => ({
      membership: { ...item.membership },
      issue: { ...item.issue },
      lane: item.lane,
      order: item.order,
      status: item.status,
    })),
    diagnostics: result.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  };
}

function validateOptions(options: ProjectQueuePollerOptions): number {
  const pollMs = options.pollMs ?? DEFAULT_PROJECT_QUEUE_POLL_MS;
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new RangeError('Project queue poll interval must be positive');
  return pollMs;
}

export function createProjectQueuePoller(options: ProjectQueuePollerOptions): ProjectQueuePoller {
  const pollMs = validateOptions(options);
  const rationaleAuditor = createQueueRationaleAuditor(options.logger, { commentClient: options.commentClient });
  let cachedProjection: ProjectQueueProjection | null = null;
  let interval: ReturnType<typeof setInterval> | undefined;
  let started = false;
  let inFlight: Promise<ProjectQueueProjection | null> | undefined;

  async function refresh(): Promise<ProjectQueueProjection | null> {
    try {
      const result = await options.reader.read();
      cachedProjection = projectionFromRead(result);
      await rationaleAuditor.observeAcceptedProjection(cachedProjection);
      options.logger.info(
        'project_queue_refresh_succeeded',
        `Project queue refresh succeeded: ${cachedProjection.items.length} items, ${cachedProjection.diagnostics.length} diagnostics`,
        { actor: 'daemon/project-queue-poller' },
      );
      return copyProjection(cachedProjection);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger.warn('project_queue_refresh_failed', `Project queue refresh failed: ${message}`, {
        actor: 'daemon/project-queue-poller',
      });
      return copyProjection(cachedProjection);
    }
  }

  function pollNow(): Promise<ProjectQueueProjection | null> {
    if (inFlight !== undefined) return inFlight;
    inFlight = refresh().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  async function start(): Promise<void> {
    started = true;
    await pollNow();
    if (started && interval === undefined) {
      interval = setInterval(() => {
        void pollNow();
      }, pollMs);
    }
  }

  function stop(): void {
    started = false;
    if (interval !== undefined) clearInterval(interval);
    interval = undefined;
  }

  return {
    start,
    stop,
    pollNow,
    snapshot: () => copyProjection(cachedProjection),
    recordDaemonReprioritization: (input) => rationaleAuditor.recordDaemonReprioritization(input),
  };
}
