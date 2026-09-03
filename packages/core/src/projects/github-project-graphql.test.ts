import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import type { FactoryLogger } from '../logger/index.js';
import {
  createGithubProjectQueuePoller,
  createOctokitGraphqlClient,
  createOctokitReprioritizationCommentClient,
} from './github-project-graphql.js';

const PROJECT_ID = 'PVT_kwDOA-board';

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

function page(itemId: string, laneValue: string, orderValue: number, statusValue: string) {
  return {
    node: {
      id: PROJECT_ID,
      items: {
        nodes: [
          {
            id: itemId,
            content: { __typename: 'Issue', id: `I_${itemId}`, number: 42 },
            fieldValues: {
              nodes: [
                { field: { name: 'Lane' }, name: laneValue },
                { field: { name: 'Order' }, number: orderValue },
                { field: { name: 'Status' }, name: statusValue },
              ],
            },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  };
}

/** The only member createOctokitGraphqlClient touches (`.graphql(query, variables)`). A structural
 *  supertype of Pick<Octokit, 'graphql'> since Octokit's graphql also carries `.defaults`/`.endpoint`
 *  metadata this adapter never reads — so widening costs one assertion, never a chain. */
interface GraphqlOctokitDouble {
  graphql(query: string, variables: any): Promise<unknown>;
}

function asGraphqlOctokit(double: GraphqlOctokitDouble): Pick<Octokit, 'graphql'> {
  return double as Pick<Octokit, 'graphql'>;
}

function fakeOctokit(graphqlMock: (query: string, variables: any) => Promise<unknown>): Pick<Octokit, 'graphql'> {
  return asGraphqlOctokit({ graphql: graphqlMock });
}

/** The only member createOctokitReprioritizationCommentClient touches
 *  (`.rest.issues.createComment(...)`) — same single-assertion-widening rationale as
 *  asGraphqlOctokit above. */
interface RestOctokitDouble {
  rest: { issues: { createComment(args: any): Promise<unknown> } };
}

function asRestOctokit(double: RestOctokitDouble): Pick<Octokit, 'rest'> {
  return double as Pick<Octokit, 'rest'>;
}

function fakeRestOctokit(createComment: (args: any) => Promise<unknown>): Pick<Octokit, 'rest'> {
  return asRestOctokit({ rest: { issues: { createComment } } });
}

describe('createOctokitGraphqlClient', () => {
  it('forwards the query and variables to octokit.graphql and resolves its result', async () => {
    const response = { some: 'result' };
    const graphqlMock = vi.fn(async (_query: string, _variables: any) => response);
    const client = createOctokitGraphqlClient(fakeOctokit(graphqlMock));

    const result = await client('query { viewer { id } }', { projectId: PROJECT_ID, cursor: null });

    expect(graphqlMock).toHaveBeenCalledExactlyOnceWith('query { viewer { id } }', {
      projectId: PROJECT_ID,
      cursor: null,
    });
    expect(result).toBe(response);
  });
});

describe('createOctokitReprioritizationCommentClient', () => {
  it('maps issueNumber/body onto octokit.rest.issues.createComment with the bound owner/repo', async () => {
    const createComment = vi.fn(async (_args: any) => ({ data: {} }));
    const client = createOctokitReprioritizationCommentClient(fakeRestOctokit(createComment), {
      owner: 'on-par',
      repo: 'software-factory',
    });

    await client.commentOnIssue({ issueNumber: 1049, body: 'rationale body' });

    expect(createComment).toHaveBeenCalledExactlyOnceWith({
      owner: 'on-par',
      repo: 'software-factory',
      issue_number: 1049,
      body: 'rationale body',
    });
  });
});

describe('createGithubProjectQueuePoller', () => {
  function buildPoller(graphqlMock: (query: string, variables: any) => Promise<unknown>) {
    return createGithubProjectQueuePoller({
      octokit: fakeOctokit(graphqlMock),
      projectId: PROJECT_ID,
      laneFieldName: 'Lane',
      orderFieldName: 'Order',
      statusFieldName: 'Status',
      statusValues: { Ready: 'ready', Done: 'done' },
      logger: createLogger(),
    });
  }

  it('produces a live snapshot with lane and order from a real ProjectV2 board response', async () => {
    const graphqlMock = vi.fn(async (_query: string, _variables: any) => page('PVTI_1', 'Build', 1, 'Ready'));
    const poller = buildPoller(graphqlMock);

    const projection = await poller.pollNow();

    expect(graphqlMock).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('ProjectQueueItems'), {
      projectId: PROJECT_ID,
      cursor: null,
    });
    expect(projection?.items[0]).toMatchObject({
      membership: { projectId: PROJECT_ID, itemId: 'PVTI_1' },
      issue: { number: 42 },
      lane: 'Build',
      order: 1,
      status: 'ready',
    });
  });

  it('reflects a reorder on the second poll without touching any local queue file', async () => {
    const graphqlMock = vi.fn<(query: string, variables: any) => Promise<unknown>>();
    graphqlMock.mockResolvedValueOnce(page('PVTI_1', 'Build', 1, 'Ready'));
    graphqlMock.mockResolvedValueOnce(page('PVTI_1', 'Build', 2, 'Ready'));
    const poller = buildPoller(graphqlMock);

    const first = await poller.pollNow();
    expect(first?.items[0]?.order).toBe(1);

    const second = await poller.pollNow();
    expect(second?.items[0]?.order).toBe(2);
    expect(graphqlMock).toHaveBeenCalledTimes(2);
  });

  it('retains the prior snapshot when a later poll fails', async () => {
    const graphqlMock = vi.fn<(query: string, variables: any) => Promise<unknown>>();
    graphqlMock.mockResolvedValueOnce(page('PVTI_1', 'Build', 1, 'Ready'));
    graphqlMock.mockRejectedValueOnce(new Error('GitHub unavailable'));
    const poller = buildPoller(graphqlMock);

    await poller.pollNow();
    const second = await poller.pollNow();

    expect(second?.items[0]?.order).toBe(1);
    expect(poller.snapshot()?.items[0]?.order).toBe(1);
  });
});
