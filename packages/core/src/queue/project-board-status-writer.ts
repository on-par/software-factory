// packages/core/src/queue/project-board-status-writer.ts — Coarse ProjectV2 status updates (#849).

import type { FactoryLogger } from '../logger/index.js';

export type ProjectBoardCoarseStatus = 'ready' | 'active' | 'blocked' | 'done';

export interface ProjectBoardStatusItem {
  /** Opaque GitHub ProjectV2 node ID. */
  readonly projectId: string;
  /** Opaque GitHub ProjectV2Item node ID. */
  readonly itemId: string;
}

export interface ProjectBoardStatusValues {
  /** Opaque single-select option ID for Ready. */
  readonly readyOptionId: string;
  /** Opaque single-select option ID for In Progress. */
  readonly inProgressOptionId: string;
  /** Opaque single-select option ID for Blocked. */
  readonly blockedOptionId: string;
  /** Opaque single-select option ID for Done. */
  readonly doneOptionId: string;
}

export interface ProjectBoardStatusConfig {
  /** Opaque GitHub ProjectV2 node ID. */
  readonly projectId: string;
  /** Opaque ProjectV2 single-select status field ID. */
  readonly statusFieldId: string;
  readonly values: ProjectBoardStatusValues;
}

export interface ProjectBoardStatusWriterOptions {
  readonly boards: readonly ProjectBoardStatusConfig[];
  graphql: (
    query: string,
    variables: {
      projectId: string;
      itemId: string;
      fieldId: string;
      value: { singleSelectOptionId: string };
    },
  ) => Promise<unknown>;
  logger: FactoryLogger;
}

export interface ProjectBoardStatusWriter {
  write(item: ProjectBoardStatusItem, status: ProjectBoardCoarseStatus): Promise<void>;
}

const UPDATE_PROJECT_BOARD_STATUS_MUTATION = `
  mutation UpdateProjectBoardStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: $value
    }) {
      projectV2Item {
        id
      }
    }
  }
`;

const OPTION_KEY_BY_STATUS: Record<ProjectBoardCoarseStatus, keyof ProjectBoardStatusValues> = {
  ready: 'readyOptionId',
  active: 'inProgressOptionId',
  blocked: 'blockedOptionId',
  done: 'doneOptionId',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasNonEmptyId(value: string): boolean {
  return value.trim() !== '';
}

function configurationError(boards: readonly ProjectBoardStatusConfig[]): Error | null {
  if (boards.length === 0)
    return new RangeError('Project board status writer configuration requires at least one board');

  const projectIds = new Set<string>();
  for (const board of boards) {
    if (
      !hasNonEmptyId(board.projectId) ||
      !hasNonEmptyId(board.statusFieldId) ||
      !hasNonEmptyId(board.values.readyOptionId) ||
      !hasNonEmptyId(board.values.inProgressOptionId) ||
      !hasNonEmptyId(board.values.blockedOptionId) ||
      !hasNonEmptyId(board.values.doneOptionId)
    ) {
      return new RangeError('Project board status writer configuration requires non-empty IDs');
    }
    if (projectIds.has(board.projectId)) {
      return new RangeError(`Project board status writer configuration has duplicate project ID: ${board.projectId}`);
    }
    projectIds.add(board.projectId);
  }
  return null;
}

function warn(logger: FactoryLogger, message: string): void {
  logger.warn('warn', message, { actor: 'daemon/project-board-status-writer' });
}

export function createProjectBoardStatusWriter(options: ProjectBoardStatusWriterOptions): ProjectBoardStatusWriter {
  const invalidConfiguration = configurationError(options.boards);
  if (invalidConfiguration !== null) {
    warn(options.logger, invalidConfiguration.message);
    throw invalidConfiguration;
  }
  const boards = new Map(options.boards.map((board) => [board.projectId, board]));

  async function write(item: ProjectBoardStatusItem, status: ProjectBoardCoarseStatus): Promise<void> {
    const optionKey = OPTION_KEY_BY_STATUS[status];
    if (optionKey === undefined) {
      warn(options.logger, `Project board status write skipped: unsupported coarse status "${String(status)}"`);
      return;
    }

    const board = boards.get(item.projectId);
    if (board === undefined) {
      warn(options.logger, `Project board status write skipped: project is not configured: ${item.projectId}`);
      return;
    }

    try {
      await options.graphql(UPDATE_PROJECT_BOARD_STATUS_MUTATION, {
        projectId: board.projectId,
        itemId: item.itemId,
        fieldId: board.statusFieldId,
        value: { singleSelectOptionId: board.values[optionKey] },
      });
    } catch (error) {
      warn(options.logger, `Project board status write failed: ${errorMessage(error)}`);
    }
  }

  return { write };
}
