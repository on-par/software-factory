// The board-writing code path is a coarse status projection only. Execution state
// (events.ndjson, cost history, lock files, breaker state) is local-only under
// ~/.factory/<repo>/ and no phase-level LaneLifecycleEvent field may ever reach a
// board mutation payload. See docs/adr/0067-execution-state-and-phase-level-events-are-local-only-never-written-to-the-board.md.

import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { LaneLifecycleEvent } from '@on-par/contracts';

import { getFactoryPaths } from '../config/index.js';
import type { FactoryLogger } from '../logger/index.js';
import type { ProjectQueuePoller, ProjectQueueProjection } from '../projects/project-queue-poller.js';
import { createProjectStatusWriter } from '../projects/project-status-writer.js';
import {
  createProjectBoardStatusWriter,
  type ProjectBoardStatusConfig,
  type ProjectBoardStatusWriterOptions,
} from './project-board-status-writer.js';

// The complete set of fields the board-writing code path (createProjectBoardStatusWriter
// -> its graphql) may touch. Widening this set is a deliberate act that must update the
// ADR in the same PR — see docs/adr/0067-...local-only...md.
const BOARD_MUTATION_ALLOWED_VARIABLE_KEYS = ['fieldId', 'itemId', 'projectId', 'value'] as const;
const BOARD_MUTATION_ALLOWED_VALUE_KEYS = ['singleSelectOptionId'] as const;

// Every field of a LaneLifecycleEvent that is phase-level execution detail and must never
// reach the board. issueId is used only to look up the ProjectV2 item, never written.
const PHASE_LEVEL_FIELDS = ['ts', 'laneId', 'issueId', 'phase', 'status', 'detail', 'worktreePath'] as const;

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

function createBoardWriteHarness() {
  const graphql = vi.fn<ProjectBoardStatusWriterOptions['graphql']>(async () => ({}));
  const boardWriter = createProjectBoardStatusWriter({ boards: [board], graphql, logger: createLogger() });
  const projectionSource: Pick<ProjectQueuePoller, 'snapshot'> = { snapshot: () => projection };
  const statusWriter = createProjectStatusWriter({ projectionSource, boardWriter });
  return { graphql, statusWriter };
}

describe('ProjectV2 status write boundary', () => {
  it('allows only the coarse status mutation variable keys', async () => {
    const { graphql, statusWriter } = createBoardWriteHarness();
    const event: LaneLifecycleEvent = {
      ts: '2026-08-25T12:00:00.000Z',
      laneId: 'issue-42',
      issueId: '42',
      phase: 'plan',
      status: 'started',
      detail: 'plan started',
      worktreePath: '/tmp/issue-42',
    };

    await statusWriter.handle(event);

    expect(graphql).toHaveBeenCalledOnce();
    const [, variables] = graphql.mock.calls[0]!;
    expect(Object.keys(variables).sort()).toEqual([...BOARD_MUTATION_ALLOWED_VARIABLE_KEYS].sort());
    expect(Object.keys((variables as { value: object }).value).sort()).toEqual([...BOARD_MUTATION_ALLOWED_VALUE_KEYS]);
  });

  it('never lets a phase-level LaneLifecycleEvent field reach the board payload', async () => {
    const { graphql, statusWriter } = createBoardWriteHarness();
    const event: LaneLifecycleEvent = {
      ts: '2026-08-25T12:00:00.000Z',
      laneId: 'SENTINEL_LANE',
      issueId: '42',
      phase: 'plan',
      status: 'started',
      detail: 'SENTINEL_DETAIL',
      worktreePath: '/tmp/SENTINEL_WORKTREE',
    };
    const sentinels: Record<(typeof PHASE_LEVEL_FIELDS)[number], string> = event;

    await statusWriter.handle(event);

    expect(graphql).toHaveBeenCalledOnce();
    const [mutation, variables] = graphql.mock.calls[0]!;
    const serialized = JSON.stringify({ mutation, variables });

    // phase/status must stay valid LaneLifecycleEvent enum values (they gate whether a write
    // happens at all) and issueId must stay a real issue number ('42') so the projection lookup
    // succeeds — none of the three can hold a unique sentinel, so they're excluded from this check.
    // issueId in particular legitimately recurs as a substring of the allowed itemId ('PVTI_42').
    const uncheckableFields = new Set(['phase', 'status', 'issueId']);
    for (const field of PHASE_LEVEL_FIELDS) {
      if (uncheckableFields.has(field)) continue;
      const sentinel = sentinels[field];
      expect(serialized, `phase-level field "${field}" leaked into board payload`).not.toContain(sentinel);
    }
  });

  it('keeps execution-state artifacts under the local state root and out of board payloads', async () => {
    const { graphql, statusWriter } = createBoardWriteHarness();
    const event: LaneLifecycleEvent = {
      ts: '2026-08-25T12:00:00.000Z',
      laneId: 'issue-42',
      issueId: '42',
      phase: 'plan',
      status: 'started',
      detail: 'plan started',
      worktreePath: '/tmp/issue-42',
    };

    await statusWriter.handle(event);

    expect(graphql).toHaveBeenCalledOnce();
    const [mutation, variables] = graphql.mock.calls[0]!;
    const serialized = JSON.stringify({ mutation, variables });

    const externalRoot = join(homedir(), '.factory', 'on-par', 'software-factory');
    const paths = getFactoryPaths('/tmp/some-checkout', externalRoot);
    const executionStateFields = [
      'events',
      'costs',
      'mergeLock',
      'gitLock',
      'runLock',
      'portsLock',
      'breaker',
    ] as const;

    for (const field of executionStateFields) {
      const path = paths[field];
      expect(path.startsWith(resolve(externalRoot)), `${field} must resolve under the external state root`).toBe(true);
      expect(serialized, `${field} path leaked into board payload`).not.toContain(path);
      expect(serialized, `${field} basename leaked into board payload`).not.toContain(basename(path));
    }
  });
});
