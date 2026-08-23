// packages/core/src/queue/project-board-poller.ts — Read-only ProjectV2 queue-intent polling (#847).

import type { FactoryLogger } from '../logger/index.js';

export const DEFAULT_PROJECT_BOARD_POLL_MS = 30_000;

export interface ProjectBoardConfig {
  /** Opaque GitHub ProjectV2 node ID. */
  projectId: string;
  laneFieldName: string;
  priorityFieldName: string;
  statusFieldName: string;
}

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

export interface ProjectBoardPollerOptions {
  boards: readonly ProjectBoardConfig[];
  graphql: (query: string, variables: { projectId: string; cursor: string | null }) => Promise<unknown>;
  logger: FactoryLogger;
  pollMs?: number;
}

export interface ProjectBoardPoller {
  start(): Promise<void>;
  stop(): void;
  pollNow(): Promise<QueueIntentSnapshot | null>;
  snapshot(): QueueIntentSnapshot | null;
}

const PROJECT_ITEMS_QUERY = `
  query ProjectBoardItems($projectId: ID!, $cursor: String) {
    node(id: $projectId) {
      ... on ProjectV2 {
        id
        items(first: 100, after: $cursor) {
          nodes {
            id
            content {
              __typename
              ... on Issue {
                id
                number
              }
            }
            fieldValues(first: 100) {
              nodes {
                field {
                  ... on ProjectV2FieldCommon {
                    name
                  }
                }
                ... on ProjectV2ItemFieldTextValue {
                  text
                }
                ... on ProjectV2ItemFieldNumberValue {
                  number
                }
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

interface RawProjectItem {
  id: string;
  content: unknown;
  fieldValues: { nodes: unknown[] };
}

interface RawProjectPage {
  node: {
    id: string;
    items: {
      nodes: RawProjectItem[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requiredString(value: unknown, description: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`Malformed ProjectV2 response: ${description}`);
  return value;
}

function parsePage(value: unknown): RawProjectPage {
  if (!isRecord(value) || !isRecord(value.node)) {
    throw new Error('Malformed ProjectV2 response: node is missing');
  }
  const node = value.node;
  const rawItems = node.items;
  if (!isRecord(rawItems)) {
    throw new Error('Malformed ProjectV2 response: ProjectV2 items are missing');
  }
  const rawNodes = rawItems.nodes;
  const rawPageInfo = rawItems.pageInfo;
  if (!Array.isArray(rawNodes) || !isRecord(rawPageInfo)) {
    throw new Error('Malformed ProjectV2 response: items page is invalid');
  }

  const hasNextPage = rawPageInfo.hasNextPage;
  const endCursor = rawPageInfo.endCursor;
  if (typeof hasNextPage !== 'boolean' || (endCursor !== null && typeof endCursor !== 'string')) {
    throw new Error('Malformed ProjectV2 response: pageInfo is invalid');
  }
  if (hasNextPage && (typeof endCursor !== 'string' || endCursor === '')) {
    throw new Error('Malformed ProjectV2 response: next page cursor is missing');
  }

  const projectItems: RawProjectItem[] = rawNodes.map((item, index) => {
    if (!isRecord(item) || !isRecord(item.fieldValues) || !Array.isArray(item.fieldValues.nodes)) {
      throw new Error(`Malformed ProjectV2 response: item ${index + 1} is invalid`);
    }
    if (!('content' in item)) throw new Error(`Malformed ProjectV2 response: item ${index + 1} content is missing`);
    return {
      id: requiredString(item.id, `item ${index + 1} ID is invalid`),
      content: item.content,
      fieldValues: { nodes: item.fieldValues.nodes },
    };
  });

  return {
    node: {
      id: requiredString(node.id, 'ProjectV2 ID is invalid'),
      items: { nodes: projectItems, pageInfo: { hasNextPage, endCursor } },
    },
  };
}

function normalizedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

function fieldValue(fieldValues: readonly unknown[], fieldName: string): string | number | null {
  for (const value of fieldValues) {
    if (!isRecord(value) || !isRecord(value.field) || typeof value.field.name !== 'string') {
      throw new Error('Malformed ProjectV2 response: item field value is invalid');
    }
    if (value.field.name !== fieldName) continue;

    const text = normalizedString(value.text);
    if (text !== null) return text;
    const number = value.number;
    if (typeof number === 'number' && Number.isFinite(number)) return number;
    const selected = normalizedString(value.name);
    if (selected !== null) return selected;
    return null;
  }
  return null;
}

function issueIdentity(content: unknown): Pick<QueueIntentItem, 'issueId' | 'issueNumber'> {
  if (content === null) return { issueId: null, issueNumber: null };
  if (!isRecord(content) || content.__typename !== 'Issue') return { issueId: null, issueNumber: null };
  const id = content.id;
  const number = content.number;
  if (typeof id !== 'string' || id === '' || typeof number !== 'number' || !Number.isInteger(number)) {
    throw new Error('Malformed ProjectV2 response: issue content is invalid');
  }
  return { issueId: id, issueNumber: number };
}

function normalizeStatus(value: string | number | null): QueueIntentStatus {
  if (typeof value !== 'string') return 'unknown';
  const status = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
  if (['queued', 'queue', 'todo', 'to do', 'backlog', 'ready', 'planned'].includes(status)) return 'queued';
  if (['active', 'in progress', 'doing', 'started', 'working'].includes(status)) return 'active';
  if (['blocked', 'on hold', 'waiting', 'stuck'].includes(status)) return 'blocked';
  if (['done', 'complete', 'completed', 'closed', 'cancelled', 'canceled', 'resolved'].includes(status)) return 'done';
  return 'unknown';
}

function normalizeItem(projectId: string, item: RawProjectItem, config: ProjectBoardConfig): QueueIntentItem {
  const lane = fieldValue(item.fieldValues.nodes, config.laneFieldName);
  const priority = fieldValue(item.fieldValues.nodes, config.priorityFieldName);
  const status = fieldValue(item.fieldValues.nodes, config.statusFieldName);
  const issue = issueIdentity(item.content);

  return {
    projectId,
    itemId: item.id,
    ...issue,
    lane: typeof lane === 'number' ? String(lane) : lane,
    priority,
    status: normalizeStatus(status),
  };
}

function copySnapshot(snapshot: QueueIntentSnapshot | null): QueueIntentSnapshot | null {
  if (snapshot === null) return null;
  return { refreshedAt: snapshot.refreshedAt, items: snapshot.items.map((item) => ({ ...item })) };
}

function validateOptions(options: ProjectBoardPollerOptions): number {
  if (options.boards.length === 0) throw new RangeError('Project board poller requires at least one board');
  for (const board of options.boards) {
    if (
      board.projectId === '' ||
      board.laneFieldName === '' ||
      board.priorityFieldName === '' ||
      board.statusFieldName === ''
    ) {
      throw new RangeError('Project board poller configuration requires non-empty IDs and field names');
    }
  }
  const pollMs = options.pollMs ?? DEFAULT_PROJECT_BOARD_POLL_MS;
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new RangeError('Project board poll interval must be positive');
  return pollMs;
}

export function createProjectBoardPoller(options: ProjectBoardPollerOptions): ProjectBoardPoller {
  const pollMs = validateOptions(options);
  let cachedSnapshot: QueueIntentSnapshot | null = null;
  let interval: ReturnType<typeof setInterval> | undefined;
  let started = false;
  let inFlight: Promise<QueueIntentSnapshot | null> | undefined;

  async function collectBoard(config: ProjectBoardConfig): Promise<QueueIntentItem[]> {
    const items: QueueIntentItem[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    do {
      const response = await options.graphql(PROJECT_ITEMS_QUERY, { projectId: config.projectId, cursor });
      const page = parsePage(response);
      if (page.node.id !== config.projectId) {
        throw new Error('Malformed ProjectV2 response: board ID does not match the configured project');
      }
      items.push(...page.node.items.nodes.map((item) => normalizeItem(config.projectId, item, config)));
      cursor = page.node.items.pageInfo.hasNextPage ? page.node.items.pageInfo.endCursor : null;
      if (cursor !== null) {
        if (seenCursors.has(cursor)) throw new Error('Malformed ProjectV2 response: repeated page cursor');
        seenCursors.add(cursor);
      }
    } while (cursor !== null);

    return items;
  }

  async function refresh(): Promise<QueueIntentSnapshot | null> {
    try {
      const results = await Promise.allSettled(options.boards.map((board) => collectBoard(board)));
      const boardItems: QueueIntentItem[][] = [];
      let failed = false;
      let failure: unknown;
      for (const result of results) {
        if (result.status === 'rejected') {
          failed = true;
          failure = result.reason;
        } else {
          boardItems.push(result.value);
        }
      }
      if (failed) throw failure;
      cachedSnapshot = { refreshedAt: new Date().toISOString(), items: boardItems.flat() };
      return copySnapshot(cachedSnapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger.warn('warn', `Project board poll failed: ${message}`, { actor: 'daemon/project-board-poller' });
      return copySnapshot(cachedSnapshot);
    }
  }

  function pollNow(): Promise<QueueIntentSnapshot | null> {
    if (inFlight) return inFlight;
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

  return { start, stop, pollNow, snapshot: () => copySnapshot(cachedSnapshot) };
}
