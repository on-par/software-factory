import { describe, expect, it, vi } from 'vitest';

import type { FactoryLogger } from '../logger/index.js';
import {
  createProjectBoardStatusWriter,
  type ProjectBoardCoarseStatus,
  type ProjectBoardStatusConfig,
} from './project-board-status-writer.js';

const board: ProjectBoardStatusConfig = {
  projectId: 'PVT_kwDOA_board',
  statusFieldId: 'PVTSSF_status',
  values: {
    readyOptionId: 'option-ready',
    inProgressOptionId: 'option-in-progress',
    blockedOptionId: 'option-blocked',
    doneOptionId: 'option-done',
  },
};

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

function createWriter(graphql = vi.fn(async () => ({}))) {
  const { logger, warnings } = createLogger();
  return {
    writer: createProjectBoardStatusWriter({ boards: [board], graphql, logger }),
    graphql,
    warnings,
  };
}

describe('createProjectBoardStatusWriter', () => {
  it.each([
    ['ready', 'option-ready'],
    ['active', 'option-in-progress'],
    ['blocked', 'option-blocked'],
    ['done', 'option-done'],
  ] as const)('maps %s queue status to its configured single-select option', async (status, optionId) => {
    const { writer, graphql } = createWriter();

    await writer.write({ projectId: board.projectId, itemId: 'PVTI_item' }, status);

    expect(graphql).toHaveBeenCalledOnce();
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining('updateProjectV2ItemFieldValue'), {
      projectId: board.projectId,
      itemId: 'PVTI_item',
      fieldId: board.statusFieldId,
      value: { singleSelectOptionId: optionId },
    });
  });

  it('writes only the configured ProjectV2 status field payload', async () => {
    const { writer, graphql } = createWriter();

    await writer.write({ projectId: board.projectId, itemId: 'PVTI_item' }, 'active');

    expect(graphql).toHaveBeenCalledWith(expect.any(String), {
      projectId: board.projectId,
      itemId: 'PVTI_item',
      fieldId: board.statusFieldId,
      value: { singleSelectOptionId: 'option-in-progress' },
    });
  });

  it('does not mutate a board for phase-like detail outside the coarse status API', async () => {
    const { writer, graphql, warnings } = createWriter();
    const phaseLikeStatus = 'BUILD' as ProjectBoardCoarseStatus;

    await writer.write({ projectId: board.projectId, itemId: 'PVTI_item' }, phaseLikeStatus);

    expect(graphql).not.toHaveBeenCalled();
    expect(warnings).toEqual([
      {
        type: 'warn',
        message: 'Project board status write skipped: unsupported coarse status "BUILD"',
        actor: 'daemon/project-board-status-writer',
      },
    ]);
  });

  it.each([
    ['missing boards', []],
    ['empty IDs', [{ ...board, statusFieldId: '' }]],
    ['duplicate project IDs', [board, { ...board }]],
  ] as const)('rejects %s configuration and records a structured warning', (_description, boards) => {
    const { logger, warnings } = createLogger();

    expect(() => createProjectBoardStatusWriter({ boards, graphql: async () => ({}), logger })).toThrow(RangeError);
    expect(warnings).toEqual([
      expect.objectContaining({
        type: 'warn',
        actor: 'daemon/project-board-status-writer',
        message: expect.stringContaining('Project board status writer configuration'),
      }),
    ]);
  });

  it('warns and resolves without a mutation for an unconfigured project', async () => {
    const { writer, graphql, warnings } = createWriter();

    await expect(writer.write({ projectId: 'PVT_unknown', itemId: 'PVTI_item' }, 'ready')).resolves.toBeUndefined();

    expect(graphql).not.toHaveBeenCalled();
    expect(warnings).toEqual([
      {
        type: 'warn',
        message: 'Project board status write skipped: project is not configured: PVT_unknown',
        actor: 'daemon/project-board-status-writer',
      },
    ]);
  });

  it('warns once and resolves when the status mutation is rejected', async () => {
    const error = new Error('GitHub unavailable');
    const { writer, graphql, warnings } = createWriter(vi.fn(async () => Promise.reject(error)));

    await expect(writer.write({ projectId: board.projectId, itemId: 'PVTI_item' }, 'done')).resolves.toBeUndefined();

    expect(graphql).toHaveBeenCalledOnce();
    expect(warnings).toEqual([
      {
        type: 'warn',
        message: 'Project board status write failed: GitHub unavailable',
        actor: 'daemon/project-board-status-writer',
      },
    ]);
  });
});
