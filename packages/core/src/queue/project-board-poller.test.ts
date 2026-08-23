import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FactoryLogger } from '../logger/index.js';
import {
  createProjectBoardPoller,
  DEFAULT_PROJECT_BOARD_POLL_MS,
  type ProjectBoardConfig,
} from './project-board-poller.js';

const board: ProjectBoardConfig = {
  projectId: 'PVT_kwDOA-board',
  laneFieldName: 'Lane',
  priorityFieldName: 'Priority',
  statusFieldName: 'Status',
};

function field(name: string, value: string | number) {
  return typeof value === 'number' ? { field: { name }, number: value } : { field: { name }, name: value };
}

function item(id: string, status: string, overrides: Partial<Record<'lane' | 'priority', string | number>> = {}) {
  return {
    id,
    content: { __typename: 'Issue', id: `I_${id}`, number: Number(id.replace(/\D/g, '')) },
    fieldValues: {
      nodes: [
        field('Lane', overrides.lane ?? 'Build'),
        field('Priority', overrides.priority ?? 3),
        field('Status', status),
      ],
    },
  };
}

function page(items: unknown[], hasNextPage = false, endCursor: string | null = null, projectId = board.projectId) {
  return { node: { id: projectId, items: { nodes: items, pageInfo: { hasNextPage, endCursor } } } };
}

function createLogger() {
  const warnings: Array<{ type: string; message: string; actor?: string }> = [];
  const logger: FactoryLogger = {
    debug: () => {},
    info: () => {},
    warn: (type, message, extra) => warnings.push({ type, message, actor: extra?.actor }),
    error: () => {},
    child: () => logger,
  };
  return { logger, warnings };
}

afterEach(() => vi.useRealTimers());

describe('createProjectBoardPoller', () => {
  it('queries each configured ProjectV2 board and normalizes membership, issue content, and configured fields', async () => {
    const calls: Array<{ query: string; variables: { projectId: string; cursor: string | null } }> = [];
    const { logger } = createLogger();
    const poller = createProjectBoardPoller({
      boards: [board],
      logger,
      graphql: async (query, variables) => {
        calls.push({ query, variables });
        return page([item('PVTI_1', 'In Progress')]);
      },
    });

    await expect(poller.pollNow()).resolves.toEqual({
      refreshedAt: expect.any(String),
      items: [
        {
          projectId: board.projectId,
          itemId: 'PVTI_1',
          issueId: 'I_PVTI_1',
          issueNumber: 1,
          lane: 'Build',
          priority: 3,
          status: 'active',
        },
      ],
    });
    expect(calls).toEqual([
      {
        query: expect.stringContaining('node(id: $projectId)'),
        variables: { projectId: board.projectId, cursor: null },
      },
    ]);
  });

  it('follows item pagination and normalizes configured text, number, and single-select values without mutating the payload', async () => {
    const first = page([item('PVTI_1', 'Queued', { lane: '  Build  ', priority: ' P1 ' })], true, 'cursor-1');
    const second = page([item('PVTI_2', 'Blocked')]);
    const { logger } = createLogger();
    const graphql = vi.fn(async (_query: string, variables: { projectId: string; cursor: string | null }) =>
      variables.cursor === null ? first : second,
    );
    const poller = createProjectBoardPoller({ boards: [board], graphql, logger });

    const snapshot = await poller.pollNow();

    expect(graphql.mock.calls.map(([, variables]) => variables)).toEqual([
      { projectId: board.projectId, cursor: null },
      { projectId: board.projectId, cursor: 'cursor-1' },
    ]);
    expect(snapshot?.items.map(({ lane, priority, status }) => ({ lane, priority, status }))).toEqual([
      { lane: 'Build', priority: 'P1', status: 'queued' },
      { lane: 'Build', priority: 3, status: 'blocked' },
    ]);
    expect(first.node.items.nodes[0]).toEqual(item('PVTI_1', 'Queued', { lane: '  Build  ', priority: ' P1 ' }));
  });

  it('uses unknown status and null fields when configured values are absent or unmapped', async () => {
    const { logger } = createLogger();
    const poller = createProjectBoardPoller({
      boards: [board],
      logger,
      graphql: async () =>
        page([
          {
            id: 'PVTI_3',
            content: null,
            fieldValues: { nodes: [field('Status', 'Needs Review')] },
          },
        ]),
    });

    await expect(poller.pollNow()).resolves.toMatchObject({
      items: [
        {
          issueId: null,
          issueNumber: null,
          lane: null,
          priority: null,
          status: 'unknown',
        },
      ],
    });
  });

  it('returns a defensive snapshot view', async () => {
    const { logger } = createLogger();
    const poller = createProjectBoardPoller({
      boards: [board],
      logger,
      graphql: async () => page([item('PVTI_1', 'Done')]),
    });

    const view = await poller.pollNow();
    if (view === null) throw new Error('expected snapshot');
    (view.items[0] as { lane: string | null }).lane = 'Mutated';

    expect(poller.snapshot()?.items[0].lane).toBe('Build');
  });

  it('starts with an immediate poll, refreshes every default interval, and stops future cycles', async () => {
    vi.useFakeTimers();
    const { logger } = createLogger();
    const graphql = vi.fn(async () => page([item('PVTI_1', 'Queued')]));
    const poller = createProjectBoardPoller({ boards: [board], graphql, logger });

    await poller.start();
    expect(graphql).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_PROJECT_BOARD_POLL_MS);
    expect(graphql).toHaveBeenCalledTimes(2);
    poller.stop();
    await vi.advanceTimersByTimeAsync(DEFAULT_PROJECT_BOARD_POLL_MS);
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it('uses an explicit positive cadence and exposes the next successful snapshot', async () => {
    vi.useFakeTimers();
    const { logger } = createLogger();
    let cycle = 0;
    const poller = createProjectBoardPoller({
      boards: [board],
      logger,
      pollMs: 17,
      graphql: async () => page([item(`PVTI_${++cycle}`, cycle === 1 ? 'Queued' : 'Done')]),
    });

    await poller.start();
    await vi.advanceTimersByTimeAsync(17);

    expect(poller.snapshot()?.items).toMatchObject([{ itemId: 'PVTI_2', status: 'done' }]);
    poller.stop();
  });

  it('queries every board and replaces the snapshot only after all boards succeed', async () => {
    const secondBoard = { ...board, projectId: 'PVT_kwDOA-second' };
    const { logger, warnings } = createLogger();
    let malformedSecondBoard = false;
    const graphql = vi.fn(async (_query: string, variables: { projectId: string; cursor: string | null }) => {
      if (variables.projectId === secondBoard.projectId && malformedSecondBoard) return { node: null };
      return page(
        [item(variables.projectId === board.projectId ? 'PVTI_1' : 'PVTI_2', malformedSecondBoard ? 'Done' : 'Queued')],
        false,
        null,
        variables.projectId,
      );
    });
    const poller = createProjectBoardPoller({ boards: [board, secondBoard], graphql, logger });

    await expect(poller.pollNow()).resolves.toMatchObject({
      items: [{ projectId: board.projectId }, { projectId: secondBoard.projectId }],
    });
    malformedSecondBoard = true;
    await expect(poller.pollNow()).resolves.toMatchObject({
      items: [
        { itemId: 'PVTI_1', status: 'queued' },
        { itemId: 'PVTI_2', status: 'queued' },
      ],
    });

    expect(graphql).toHaveBeenCalledTimes(4);
    expect(warnings).toHaveLength(1);
  });

  it('shares an in-flight refresh instead of overlapping GraphQL cycles', async () => {
    const { logger } = createLogger();
    let resolvePage: ((value: unknown) => void) | undefined;
    const graphql = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolvePage = resolve;
        }),
    );
    const poller = createProjectBoardPoller({ boards: [board], graphql, logger });

    const first = poller.pollNow();
    const second = poller.pollNow();
    expect(graphql).toHaveBeenCalledTimes(1);
    resolvePage?.(page([item('PVTI_1', 'Queued')]));

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ items: [expect.objectContaining({ itemId: 'PVTI_1' })] }),
      expect.objectContaining({ items: [expect.objectContaining({ itemId: 'PVTI_1' })] }),
    ]);
  });

  it('waits for every board request to settle before allowing a failed cycle to be retried', async () => {
    const secondBoard = { ...board, projectId: 'PVT_kwDOA-second' };
    const { logger, warnings } = createLogger();
    let resolveSecondBoard: ((value: unknown) => void) | undefined;
    const graphql = vi.fn((_query: string, variables: { projectId: string; cursor: string | null }) => {
      if (variables.projectId === board.projectId) return Promise.reject(new Error('GitHub unavailable'));
      return new Promise<unknown>((resolve) => {
        resolveSecondBoard = resolve;
      });
    });
    const poller = createProjectBoardPoller({ boards: [board, secondBoard], graphql, logger });

    const first = poller.pollNow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = poller.pollNow();

    expect(second).toBe(first);
    expect(graphql).toHaveBeenCalledTimes(2);
    resolveSecondBoard?.(page([item('PVTI_2', 'Queued')], false, null, secondBoard.projectId));
    await expect(first).resolves.toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('retains the last valid snapshot and logs a structured daemon warning when GraphQL fails', async () => {
    const { logger, warnings } = createLogger();
    let shouldFail = false;
    const poller = createProjectBoardPoller({
      boards: [board],
      logger,
      graphql: async () => {
        if (shouldFail) throw new Error('GitHub unavailable');
        return page([item('PVTI_1', 'Queued')]);
      },
    });

    await poller.pollNow();
    shouldFail = true;
    await expect(poller.pollNow()).resolves.toMatchObject({ items: [{ itemId: 'PVTI_1' }] });

    expect(poller.snapshot()?.items).toMatchObject([{ itemId: 'PVTI_1' }]);
    expect(warnings).toEqual([
      {
        type: 'warn',
        message: 'Project board poll failed: GitHub unavailable',
        actor: 'daemon/project-board-poller',
      },
    ]);
  });

  it('keeps initial intent null and warns when a response is malformed', async () => {
    const { logger, warnings } = createLogger();
    const poller = createProjectBoardPoller({
      boards: [board],
      logger,
      graphql: async () => ({ node: { id: board.projectId, items: { nodes: 'not-an-array' } } }),
    });

    await expect(poller.pollNow()).resolves.toBeNull();

    expect(poller.snapshot()).toBeNull();
    expect(warnings).toEqual([
      {
        type: 'warn',
        message: 'Project board poll failed: Malformed ProjectV2 response: items page is invalid',
        actor: 'daemon/project-board-poller',
      },
    ]);
  });

  it('keeps initial intent null when a response belongs to a different ProjectV2 board', async () => {
    const { logger, warnings } = createLogger();
    const poller = createProjectBoardPoller({
      boards: [board],
      logger,
      graphql: async () => page([item('PVTI_1', 'Queued')], false, null, 'PVT_other'),
    });

    await expect(poller.pollNow()).resolves.toBeNull();

    expect(warnings).toEqual([
      {
        type: 'warn',
        message:
          'Project board poll failed: Malformed ProjectV2 response: board ID does not match the configured project',
        actor: 'daemon/project-board-poller',
      },
    ]);
  });
});
