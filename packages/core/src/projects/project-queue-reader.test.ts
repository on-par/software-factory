import { describe, expect, it, vi } from 'vitest';

import { createProjectQueueReader, type ProjectQueueReaderOptions } from './project-queue-reader.js';

const projectId = 'PVT_kwDOA-board';

const options: Omit<ProjectQueueReaderOptions, 'graphql'> = {
  projectId,
  laneFieldName: 'Lane',
  orderFieldName: 'Order',
  statusFieldName: 'Status',
  statusValues: {
    Backlog: 'backlog',
    Ready: 'ready',
    'In Progress': 'in_progress',
    Blocked: 'blocked',
    Done: 'done',
  },
};

function field(name: string, value: string | number) {
  return typeof value === 'number' ? { field: { name }, number: value } : { field: { name }, name: value };
}

function textField(name: string, text: string) {
  return { field: { name }, text };
}

function item(id: string, number: number, status: string) {
  return {
    id,
    content: { __typename: 'Issue', id: `I_${id}`, number },
    fieldValues: { nodes: [field('Lane', ' Build '), field('Order', number), field('Status', ` ${status} `)] },
  };
}

function page(items: unknown[]) {
  return { node: { id: projectId, items: { nodes: items, pageInfo: { hasNextPage: false, endCursor: null } } } };
}

describe('createProjectQueueReader', () => {
  it('queries ProjectV2 and maps configured statuses to complete queue intent', async () => {
    const graphql = vi.fn(async (_query: string, _variables: { projectId: string; cursor: string | null }) =>
      page([
        item('PVTI_1', 1, 'Backlog'),
        item('PVTI_2', 2, 'Ready'),
        item('PVTI_3', 3, 'In Progress'),
        item('PVTI_4', 4, 'Blocked'),
        item('PVTI_5', 5, 'Done'),
      ]),
    );
    const reader = createProjectQueueReader({ ...options, graphql });

    await expect(reader.read()).resolves.toEqual({
      items: [
        {
          membership: { projectId, itemId: 'PVTI_1' },
          issue: { id: 'I_PVTI_1', number: 1 },
          lane: 'Build',
          order: 1,
          status: 'backlog',
        },
        {
          membership: { projectId, itemId: 'PVTI_2' },
          issue: { id: 'I_PVTI_2', number: 2 },
          lane: 'Build',
          order: 2,
          status: 'ready',
        },
        {
          membership: { projectId, itemId: 'PVTI_3' },
          issue: { id: 'I_PVTI_3', number: 3 },
          lane: 'Build',
          order: 3,
          status: 'in_progress',
        },
        {
          membership: { projectId, itemId: 'PVTI_4' },
          issue: { id: 'I_PVTI_4', number: 4 },
          lane: 'Build',
          order: 4,
          status: 'blocked',
        },
        {
          membership: { projectId, itemId: 'PVTI_5' },
          issue: { id: 'I_PVTI_5', number: 5 },
          lane: 'Build',
          order: 5,
          status: 'done',
        },
      ],
      diagnostics: [],
    });
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining('query ProjectQueueItems'), {
      projectId,
      cursor: null,
    });
    expect(graphql.mock.calls[0]?.[0]).toContain('node(id: $projectId)');
  });

  it('follows every page cursor once and retains board order across pages', async () => {
    const firstPage = {
      node: {
        id: projectId,
        items: { nodes: [item('PVTI_1', 1, 'Ready')], pageInfo: { hasNextPage: true, endCursor: 'cursor-1' } },
      },
    };
    const secondPage = page([
      {
        ...item('PVTI_2', 2, 'Done'),
        fieldValues: { nodes: [field('Lane', 'Ship'), textField('Order', ' P2 '), field('Status', 'Done')] },
      },
    ]);
    const graphql = vi.fn(async (_query: string, variables: { projectId: string; cursor: string | null }) =>
      variables.cursor === null ? firstPage : secondPage,
    );

    const result = await createProjectQueueReader({ ...options, graphql }).read();

    expect(graphql.mock.calls.map(([, variables]) => variables)).toEqual([
      { projectId, cursor: null },
      { projectId, cursor: 'cursor-1' },
    ]);
    expect(result.items.map(({ membership, lane, order, status }) => ({ membership, lane, order, status }))).toEqual([
      { membership: { projectId, itemId: 'PVTI_1' }, lane: 'Build', order: 1, status: 'ready' },
      { membership: { projectId, itemId: 'PVTI_2' }, lane: 'Ship', order: 'P2', status: 'done' },
    ]);
  });

  it('omits incomplete or unmapped items while retaining complete siblings with diagnostics', async () => {
    const graphql = vi.fn(async () =>
      page([
        item('PVTI_valid', 1, 'Ready'),
        { id: 'PVTI_not-issue', content: null, fieldValues: { nodes: [] } },
        { ...item('PVTI_no-lane', 3, 'Ready'), fieldValues: { nodes: [field('Order', 3), field('Status', 'Ready')] } },
        {
          ...item('PVTI_no-order', 4, 'Ready'),
          fieldValues: { nodes: [field('Lane', 'Build'), field('Status', 'Ready')] },
        },
        { ...item('PVTI_no-status', 5, 'Ready'), fieldValues: { nodes: [field('Lane', 'Build'), field('Order', 5)] } },
        {
          ...item('PVTI_unmapped', 6, 'Review'),
          fieldValues: { nodes: [field('Lane', 'Build'), field('Order', 6), field('Status', ' Review ')] },
        },
      ]),
    );

    await expect(createProjectQueueReader({ ...options, graphql }).read()).resolves.toEqual({
      items: [
        {
          membership: { projectId, itemId: 'PVTI_valid' },
          issue: { id: 'I_PVTI_valid', number: 1 },
          lane: 'Build',
          order: 1,
          status: 'ready',
        },
      ],
      diagnostics: [
        { projectId, itemId: 'PVTI_not-issue', reason: 'missing_issue' },
        { projectId, itemId: 'PVTI_no-lane', reason: 'missing_lane_field' },
        { projectId, itemId: 'PVTI_no-order', reason: 'missing_order_field' },
        { projectId, itemId: 'PVTI_no-status', reason: 'missing_status_field' },
        { projectId, itemId: 'PVTI_unmapped', reason: 'unmapped_status_value' },
      ],
    });
  });

  it.each([
    ['missing ProjectV2 node', { node: null }, 'Malformed ProjectV2 response: node is missing'],
    [
      'missing next cursor',
      { node: { id: projectId, items: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } },
      'Malformed ProjectV2 response: next page cursor is missing',
    ],
  ])('rejects malformed pagination data: %s', async (_description, response, message) => {
    const reader = createProjectQueueReader({ ...options, graphql: async () => response });

    await expect(reader.read()).rejects.toThrow(message);
  });

  it('rejects a repeated pagination cursor', async () => {
    const repeatedPage = {
      node: {
        id: projectId,
        items: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same-cursor' } },
      },
    };
    const reader = createProjectQueueReader({ ...options, graphql: async () => repeatedPage });

    await expect(reader.read()).rejects.toThrow('Malformed ProjectV2 response: repeated page cursor');
  });
});
