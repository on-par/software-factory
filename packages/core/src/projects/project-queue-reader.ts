export type ProjectQueueStatus = 'backlog' | 'ready' | 'in_progress' | 'blocked' | 'done';

export interface ProjectQueueIntentItem {
  readonly membership: { readonly projectId: string; readonly itemId: string };
  readonly issue: { readonly id: string; readonly number: number };
  readonly lane: string;
  readonly order: string | number;
  readonly status: ProjectQueueStatus;
}

export type ProjectQueueReadDiagnosticReason =
  'missing_issue' | 'missing_lane_field' | 'missing_order_field' | 'missing_status_field' | 'unmapped_status_value';

export interface ProjectQueueReadDiagnostic {
  readonly projectId: string;
  readonly itemId?: string;
  readonly reason: ProjectQueueReadDiagnosticReason;
}

export interface ProjectQueueReadResult {
  readonly items: readonly ProjectQueueIntentItem[];
  readonly diagnostics: readonly ProjectQueueReadDiagnostic[];
}

export interface ProjectQueueReaderOptions {
  readonly projectId: string;
  readonly graphql: (query: string, variables: { projectId: string; cursor: string | null }) => Promise<unknown>;
  readonly laneFieldName: string;
  readonly orderFieldName: string;
  readonly statusFieldName: string;
  readonly statusValues: Readonly<Record<string, ProjectQueueStatus>>;
}

export interface ProjectQueueReader {
  read(): Promise<ProjectQueueReadResult>;
}

const PROJECT_QUEUE_ITEMS_QUERY = `
  query ProjectQueueItems($projectId: ID!, $cursor: String) {
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

interface RawProjectPage {
  readonly projectId: string;
  readonly items: readonly unknown[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
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
  if (!isRecord(value.node.items)) {
    throw new Error('Malformed ProjectV2 response: ProjectV2 items are missing');
  }

  const { items } = value.node;
  if (!Array.isArray(items.nodes) || !isRecord(items.pageInfo)) {
    throw new Error('Malformed ProjectV2 response: items page is invalid');
  }
  const { hasNextPage, endCursor } = items.pageInfo;
  if (typeof hasNextPage !== 'boolean' || (endCursor !== null && typeof endCursor !== 'string')) {
    throw new Error('Malformed ProjectV2 response: pageInfo is invalid');
  }
  if (hasNextPage && (typeof endCursor !== 'string' || endCursor === '')) {
    throw new Error('Malformed ProjectV2 response: next page cursor is missing');
  }

  return {
    projectId: requiredString(value.node.id, 'ProjectV2 ID is invalid'),
    items: items.nodes,
    hasNextPage,
    endCursor,
  };
}

function normalizedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

function itemId(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  const id = normalizedString(item.id);
  return id ?? undefined;
}

function issue(item: unknown): ProjectQueueIntentItem['issue'] | null {
  if (!isRecord(item) || !isRecord(item.content) || item.content.__typename !== 'Issue') return null;
  const id = normalizedString(item.content.id);
  const number = item.content.number;
  if (id === null || typeof number !== 'number' || !Number.isInteger(number)) return null;
  return { id, number };
}

function fieldValue(item: unknown, fieldName: string): string | number | null {
  if (!isRecord(item) || !isRecord(item.fieldValues) || !Array.isArray(item.fieldValues.nodes)) return null;
  for (const value of item.fieldValues.nodes) {
    if (!isRecord(value) || !isRecord(value.field) || value.field.name !== fieldName) continue;

    const text = normalizedString(value.text);
    if (text !== null) return text;
    if (typeof value.number === 'number' && Number.isFinite(value.number)) return value.number;
    const selected = normalizedString(value.name);
    if (selected !== null) return selected;
    return null;
  }
  return null;
}

function diagnostic(
  projectId: string,
  itemId: string | undefined,
  reason: ProjectQueueReadDiagnosticReason,
): ProjectQueueReadDiagnostic {
  return itemId === undefined ? { projectId, reason } : { projectId, itemId, reason };
}

function normalizeItem(
  projectId: string,
  item: unknown,
  options: ProjectQueueReaderOptions,
): ProjectQueueIntentItem | ProjectQueueReadDiagnostic {
  const membershipItemId = itemId(item);
  const issueIdentity = issue(item);
  if (membershipItemId === undefined || issueIdentity === null) {
    return diagnostic(projectId, membershipItemId, 'missing_issue');
  }

  const lane = fieldValue(item, options.laneFieldName);
  if (typeof lane !== 'string') return diagnostic(projectId, membershipItemId, 'missing_lane_field');

  const order = fieldValue(item, options.orderFieldName);
  if (order === null) return diagnostic(projectId, membershipItemId, 'missing_order_field');

  const statusValue = fieldValue(item, options.statusFieldName);
  if (typeof statusValue !== 'string') return diagnostic(projectId, membershipItemId, 'missing_status_field');

  const status = options.statusValues[statusValue];
  if (status === undefined) return diagnostic(projectId, membershipItemId, 'unmapped_status_value');

  return {
    membership: { projectId, itemId: membershipItemId },
    issue: issueIdentity,
    lane,
    order,
    status,
  };
}

function validateOptions(options: ProjectQueueReaderOptions): void {
  if (
    options.projectId === '' ||
    options.laneFieldName === '' ||
    options.orderFieldName === '' ||
    options.statusFieldName === ''
  ) {
    throw new RangeError('Project queue reader requires non-empty project ID and field names');
  }
}

export function createProjectQueueReader(options: ProjectQueueReaderOptions): ProjectQueueReader {
  validateOptions(options);

  return {
    async read(): Promise<ProjectQueueReadResult> {
      const items: ProjectQueueIntentItem[] = [];
      const diagnostics: ProjectQueueReadDiagnostic[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;

      do {
        const response = await options.graphql(PROJECT_QUEUE_ITEMS_QUERY, { projectId: options.projectId, cursor });
        const page = parsePage(response);
        if (page.projectId !== options.projectId) {
          throw new Error('Malformed ProjectV2 response: board ID does not match the configured project');
        }

        for (const rawItem of page.items) {
          const normalized = normalizeItem(options.projectId, rawItem, options);
          if ('reason' in normalized) diagnostics.push(normalized);
          else items.push(normalized);
        }

        cursor = page.hasNextPage ? page.endCursor : null;
        if (cursor !== null) {
          if (seenCursors.has(cursor)) throw new Error('Malformed ProjectV2 response: repeated page cursor');
          seenCursors.add(cursor);
        }
      } while (cursor !== null);

      return { items, diagnostics };
    },
  };
}
