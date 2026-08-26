import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FactoryLogger } from '../logger/index.js';
import type { ProjectQueueReadResult, ProjectQueueReader } from './project-queue-reader.js';
import { createProjectQueuePoller, DEFAULT_PROJECT_QUEUE_POLL_MS } from './project-queue-poller.js';

function result(
  itemId: string,
  lane: string,
  order: string | number,
  status: 'backlog' | 'ready' | 'in_progress' | 'blocked' | 'done',
  diagnostics: ProjectQueueReadResult['diagnostics'] = [],
): ProjectQueueReadResult {
  return {
    items: [
      {
        membership: { projectId: 'PVT_kwDOA-board', itemId },
        issue: { id: `I_${itemId}`, number: Number(itemId.replace(/\D/g, '')) },
        lane,
        order,
        status,
      },
    ],
    diagnostics,
  };
}

function createLogger() {
  const infos: Array<{ type: string; message: string; actor?: string }> = [];
  const warnings: Array<{ type: string; message: string; actor?: string }> = [];
  const logger: FactoryLogger = {
    debug: () => {},
    info: (type, message, extra) => infos.push({ type, message, actor: extra?.actor }),
    warn: (type, message, extra) => warnings.push({ type, message, actor: extra?.actor }),
    error: () => {},
    child: () => logger,
  };
  return { logger, infos, warnings };
}

afterEach(() => vi.useRealTimers());

describe('createProjectQueuePoller', () => {
  it('starts with an immediate refresh, uses the default cadence, and stops future refreshes', async () => {
    vi.useFakeTimers();
    const { logger } = createLogger();
    const reader: ProjectQueueReader = { read: vi.fn(async () => result('PVTI_1', 'Build', 1, 'ready')) };
    const poller = createProjectQueuePoller({ reader, logger });

    await poller.start();
    expect(reader.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_PROJECT_QUEUE_POLL_MS);
    expect(reader.read).toHaveBeenCalledTimes(2);

    poller.stop();
    await vi.advanceTimersByTimeAsync(DEFAULT_PROJECT_QUEUE_POLL_MS);
    expect(reader.read).toHaveBeenCalledTimes(2);
  });

  it('uses a positive explicit cadence and atomically replaces complete accepted intent', async () => {
    vi.useFakeTimers();
    const { logger } = createLogger();
    const first = result('PVTI_1', 'Build', 1, 'ready', [
      { projectId: 'PVT_kwDOA-board', itemId: 'PVTI_missing', reason: 'missing_status_field' },
    ]);
    const second = result('PVTI_2', 'Ship', 'P2', 'done');
    const reader: ProjectQueueReader = { read: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) };
    const poller = createProjectQueuePoller({ reader, logger, pollMs: 17 });

    await poller.start();
    expect(poller.snapshot()).toMatchObject({
      items: [{ membership: { itemId: 'PVTI_1' }, lane: 'Build', order: 1, status: 'ready' }],
      diagnostics: [{ itemId: 'PVTI_missing', reason: 'missing_status_field' }],
    });

    await vi.advanceTimersByTimeAsync(17);
    expect(poller.snapshot()).toMatchObject({
      items: [{ membership: { itemId: 'PVTI_2' }, lane: 'Ship', order: 'P2', status: 'done' }],
      diagnostics: [],
    });
    poller.stop();
  });

  it('returns defensive views of nested queue values and diagnostics', async () => {
    const { logger } = createLogger();
    const poller = createProjectQueuePoller({
      logger,
      reader: {
        read: async () =>
          result('PVTI_1', 'Build', 1, 'ready', [
            { projectId: 'PVT_kwDOA-board', itemId: 'PVTI_missing', reason: 'missing_lane_field' },
          ]),
      },
    });

    const view = await poller.pollNow();
    if (view === null) throw new Error('expected projection');
    (view.items[0] as { membership: { itemId: string }; issue: { number: number }; lane: string }).membership.itemId =
      'mutated';
    (view.items[0] as { issue: { number: number } }).issue.number = 999;
    (view.items[0] as { lane: string }).lane = 'Mutated';
    (view.diagnostics[0] as { itemId?: string }).itemId = 'mutated';

    expect(poller.snapshot()).toMatchObject({
      items: [{ membership: { itemId: 'PVTI_1' }, issue: { number: 1 }, lane: 'Build' }],
      diagnostics: [{ itemId: 'PVTI_missing', reason: 'missing_lane_field' }],
    });
  });

  it('retains the accepted projection after a failed refresh and records typed diagnostics', async () => {
    const { logger, infos, warnings } = createLogger();
    const reader: ProjectQueueReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce(result('PVTI_1', 'Build', 1, 'ready'))
        .mockRejectedValueOnce(new Error('GitHub unavailable')),
    };
    const poller = createProjectQueuePoller({ reader, logger });

    await poller.pollNow();
    await expect(poller.pollNow()).resolves.toMatchObject({
      items: [{ membership: { itemId: 'PVTI_1' }, lane: 'Build', order: 1, status: 'ready' }],
    });

    expect(infos).toEqual([
      {
        type: 'project_queue_refresh_succeeded',
        message: 'Project queue refresh succeeded: 1 items, 0 diagnostics',
        actor: 'daemon/project-queue-poller',
      },
    ]);
    expect(warnings).toEqual([
      {
        type: 'project_queue_refresh_failed',
        message: 'Project queue refresh failed: GitHub unavailable',
        actor: 'daemon/project-queue-poller',
      },
    ]);
  });

  it('keeps the projection null when its initial refresh fails', async () => {
    const { logger } = createLogger();
    const poller = createProjectQueuePoller({
      logger,
      reader: { read: async () => Promise.reject(new Error('GitHub unavailable')) },
    });

    await expect(poller.pollNow()).resolves.toBeNull();
    expect(poller.snapshot()).toBeNull();
  });

  it('coalesces manual and timer refreshes while one reader call is pending', async () => {
    vi.useFakeTimers();
    const { logger } = createLogger();
    let resolveRead: ((value: ProjectQueueReadResult) => void) | undefined;
    const reader: ProjectQueueReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce(result('PVTI_1', 'Build', 1, 'ready'))
        .mockImplementationOnce(
          () =>
            new Promise<ProjectQueueReadResult>((resolve) => {
              resolveRead = resolve;
            }),
        ),
    };
    const poller = createProjectQueuePoller({ reader, logger, pollMs: 17 });

    await poller.start();
    await vi.advanceTimersByTimeAsync(17);
    const first = poller.pollNow();
    const second = poller.pollNow();
    expect(second).toBe(first);
    expect(reader.read).toHaveBeenCalledTimes(2);

    resolveRead?.(result('PVTI_1', 'Build', 1, 'ready'));
    await expect(first).resolves.toMatchObject({ items: [{ membership: { itemId: 'PVTI_1' } }] });
    poller.stop();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid polling overrides: %s', (pollMs) => {
    const { logger } = createLogger();
    expect(() =>
      createProjectQueuePoller({ reader: { read: async () => result('PVTI_1', 'Build', 1, 'ready') }, logger, pollMs }),
    ).toThrow('Project queue poll interval must be positive');
  });
});
