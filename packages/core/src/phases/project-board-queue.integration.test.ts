import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

import type { LaneLifecycleEvent } from '@on-par/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getFactoryPaths } from '../config/index.js';
import { createLogger } from '../logger/index.js';
import { createProjectBoardStatusWriter } from '../queue/project-board-status-writer.js';
import { createProjectQueuePoller, type ProjectQueuePoller } from '../projects/project-queue-poller.js';
import { createProjectQueueReader } from '../projects/project-queue-reader.js';
import { createProjectStatusWriter } from '../projects/project-status-writer.js';
import { createBoardQueueScheduler } from './board-queue-scheduler.js';

const projectId = 'PVT_kwDOA_board';
const statusFieldId = 'PVTSSF_status';
const pollMs = 25;

const statusOptionIds = {
  Ready: 'option-ready',
  'In Progress': 'option-in-progress',
  Blocked: 'option-blocked',
  Done: 'option-done',
} as const;

type BoardStatus = keyof typeof statusOptionIds;

interface BoardItem {
  readonly itemId: string;
  readonly issueId: string;
  readonly issueNumber: number;
  readonly lane: string;
  readonly order: number;
  status: BoardStatus;
}

interface QueueVariables {
  readonly projectId: string;
  readonly cursor: string | null;
}

interface StatusVariables {
  readonly projectId: string;
  readonly itemId: string;
  readonly fieldId: string;
  readonly value: { readonly singleSelectOptionId: string };
}

interface GraphqlCapture {
  readonly query: string;
  readonly variables: QueueVariables | StatusVariables;
}

function createProjectFixture(initialItems: readonly BoardItem[]) {
  let items = initialItems.map((item) => ({ ...item }));
  const queries: GraphqlCapture[] = [];
  const mutations: GraphqlCapture[] = [];

  function queueSnapshot() {
    return {
      node: {
        id: projectId,
        items: {
          nodes: items.map((item) => ({
            id: item.itemId,
            content: { __typename: 'Issue', id: item.issueId, number: item.issueNumber },
            fieldValues: {
              nodes: [
                { field: { name: 'Lane' }, name: item.lane },
                { field: { name: 'Order' }, number: item.order },
                { field: { name: 'Status' }, name: item.status },
              ],
            },
          })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
  }

  function statusFor(itemId: string): BoardStatus | undefined {
    return items.find((item) => item.itemId === itemId)?.status;
  }

  function statusForOption(optionId: string): BoardStatus {
    const matched = Object.entries(statusOptionIds).find(([, id]) => id === optionId)?.[0];
    if (matched === undefined) throw new Error(`Unknown status option: ${optionId}`);
    return matched as BoardStatus;
  }

  function graphql(query: string, variables: QueueVariables): Promise<unknown>;
  function graphql(query: string, variables: StatusVariables): Promise<unknown>;
  async function graphql(query: string, variables: QueueVariables | StatusVariables): Promise<unknown> {
    if (query.includes('query ProjectQueueItems')) {
      queries.push({ query, variables });
      return queueSnapshot();
    }

    if (query.includes('mutation UpdateProjectBoardStatus')) {
      mutations.push({ query, variables });
      if (!('fieldId' in variables) || variables.projectId !== projectId || variables.fieldId !== statusFieldId) {
        throw new Error('Unexpected ProjectV2 status mutation');
      }
      const item = items.find((candidate) => candidate.itemId === variables.itemId);
      if (item === undefined) throw new Error(`Unknown ProjectV2 item: ${variables.itemId}`);
      item.status = statusForOption(variables.value.singleSelectOptionId);
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: item.itemId } } };
    }

    throw new Error('Unexpected GraphQL operation');
  }

  return {
    graphql,
    queries,
    mutations,
    replaceItems(nextItems: readonly BoardItem[]) {
      items = nextItems.map((item) => ({ ...item }));
    },
    statusFor,
  };
}

function lifecycleEvent(overrides: Partial<LaneLifecycleEvent> = {}): LaneLifecycleEvent {
  return {
    ts: '2026-08-25T12:00:00.000Z',
    laneId: 'issue-101',
    issueId: '101',
    phase: 'plan',
    status: 'started',
    detail: 'lifecycle detail with events, costs, locks, and breaker state',
    worktreePath: '/tmp/factory/issue-101-worktree',
    ...overrides,
  };
}

function isBelow(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot !== '' && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot)
  );
}

let repoRoot: string | undefined;
let poller: ProjectQueuePoller | undefined;

afterEach(async () => {
  poller?.stop();
  poller = undefined;
  vi.useRealTimers();
  if (repoRoot !== undefined) await rm(repoRoot, { recursive: true, force: true });
  repoRoot = undefined;
});

describe('ProjectV2 board and local factory state boundary', () => {
  it('polls board-owned scheduling intent while keeping lifecycle detail and execution artifacts local', async () => {
    vi.useFakeTimers();
    repoRoot = await mkdtemp(join(tmpdir(), 'factory-project-board-queue-'));
    const paths = getFactoryPaths(repoRoot);
    const logger = createLogger(
      paths.events,
      {},
      { out: { write: () => {}, isTTY: false }, env: { FACTORY_LOG_LEVEL: 'error' } },
    );
    const fixture = createProjectFixture([
      { itemId: 'PVTI_101', issueId: 'I_101', issueNumber: 101, lane: 'Build', order: 1, status: 'Ready' },
      { itemId: 'PVTI_102', issueId: 'I_102', issueNumber: 102, lane: 'Build', order: 2, status: 'Ready' },
    ]);
    const reader = createProjectQueueReader({
      projectId,
      graphql: fixture.graphql,
      laneFieldName: 'Lane',
      orderFieldName: 'Order',
      statusFieldName: 'Status',
      statusValues: {
        Ready: 'ready',
        'In Progress': 'in_progress',
        Blocked: 'blocked',
        Done: 'done',
      },
    });
    poller = createProjectQueuePoller({ reader, logger, pollMs });
    const scheduler = createBoardQueueScheduler({ projectionReader: poller, dispatchableStatuses: ['ready'] });
    const first = { issueNumber: 101, localState: 'first local candidate' };
    const removed = { issueNumber: 102, localState: 'removed local candidate' };
    const added = { issueNumber: 103, localState: 'added local candidate' };

    await poller.start();
    expect(scheduler.select([first, removed, added])).toEqual(new Map([['Build', [first, removed]]]));
    expect(existsSync(paths.queue)).toBe(false);

    fixture.replaceItems([
      { itemId: 'PVTI_101', issueId: 'I_101', issueNumber: 101, lane: 'Ship', order: 2, status: 'Ready' },
      { itemId: 'PVTI_103', issueId: 'I_103', issueNumber: 103, lane: 'Ship', order: 1, status: 'Ready' },
    ]);
    await vi.advanceTimersByTimeAsync(pollMs);

    expect(scheduler.select([first, removed, added])).toEqual(new Map([['Ship', [added, first]]]));
    expect(existsSync(paths.queue)).toBe(false);
    expect(fixture.statusFor('PVTI_101')).toBe('Ready');

    const boardWriter = createProjectBoardStatusWriter({
      boards: [
        {
          projectId,
          statusFieldId,
          values: {
            readyOptionId: statusOptionIds.Ready,
            inProgressOptionId: statusOptionIds['In Progress'],
            blockedOptionId: statusOptionIds.Blocked,
            doneOptionId: statusOptionIds.Done,
          },
        },
      ],
      graphql: fixture.graphql,
      logger,
    });
    const statusWriter = createProjectStatusWriter({ projectionSource: poller, boardWriter });

    await statusWriter.handle(lifecycleEvent());
    expect(fixture.statusFor('PVTI_101')).toBe('In Progress');
    await statusWriter.handle(lifecycleEvent({ phase: 'build', status: 'done' }));
    await statusWriter.handle(lifecycleEvent({ phase: 'check', status: 'progress' }));
    await statusWriter.handle(lifecycleEvent({ phase: 'ship', status: 'done' }));
    expect(fixture.statusFor('PVTI_101')).toBe('Done');

    expect(fixture.mutations.map(({ variables }) => variables)).toEqual([
      {
        projectId,
        itemId: 'PVTI_101',
        fieldId: statusFieldId,
        value: { singleSelectOptionId: statusOptionIds['In Progress'] },
      },
      {
        projectId,
        itemId: 'PVTI_101',
        fieldId: statusFieldId,
        value: { singleSelectOptionId: statusOptionIds.Done },
      },
    ]);

    const capturedBoardWrites = structuredClone(fixture.mutations);
    await writeFile(paths.costs, '{"cost": 1}\n');
    await writeFile(paths.mergeLock, 'issue-101 lock\n');
    await writeFile(paths.breaker, '{"provider":"local"}\n');
    logger.info('local-only', 'recorded representative local execution event', { actor: 'daemon/integration-test' });

    const localArtifacts = [paths.events, paths.costs, paths.mergeLock, paths.breaker];
    for (const artifact of localArtifacts) {
      expect(existsSync(artifact)).toBe(true);
      expect(isBelow(paths.state, artifact)).toBe(true);
    }
    expect(existsSync(paths.queue)).toBe(false);
    expect(fixture.mutations).toEqual(capturedBoardWrites);

    for (const capture of [...fixture.queries, ...fixture.mutations]) {
      const serialized = JSON.stringify(capture);
      expect(serialized).not.toContain('lifecycle detail');
      expect(serialized).not.toContain('worktreePath');
      expect(serialized).not.toContain('events');
      expect(serialized).not.toContain('costs');
      expect(serialized).not.toContain('locks');
      expect(serialized).not.toContain('breaker');
    }
  });
});
