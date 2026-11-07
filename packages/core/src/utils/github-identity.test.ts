// src/utils/github-identity.test.ts — self identity for user tokens and GitHub App installation tokens
import { describe, expect, it } from 'vitest';

import { createSimOctokit, type SimOctokitStep } from '../fakes/octokit.js';
import { isOwnComment, resolveSelfIdentity, type SelfIdentity } from './github-identity.js';

const httpError = (status: number, message: string): Error => Object.assign(new Error(message), { status });
const INTEGRATION_403 = (): Error => httpError(403, 'Resource not accessible by integration');

function octokitWith(rest: SimOctokitStep, graphql?: SimOctokitStep) {
  const { octokit, calls } = createSimOctokit({
    endpoints: { 'users.getAuthenticated': [rest], ...(graphql ? { graphql: [graphql] } : {}) },
  });
  const graphqlCalls = () => calls.filter((c) => c[0] === 'graphql');
  return { octokit, graphqlCalls };
}

describe('resolveSelfIdentity', () => {
  it('returns the REST identity for a user token and never asks GraphQL', async () => {
    const { octokit, graphqlCalls } = octokitWith({ response: { data: { id: 7, login: 'octo', type: 'User' } } });
    expect(await resolveSelfIdentity(octokit as never)).toEqual({ id: 7, login: 'octo', kind: 'user' });
    expect(graphqlCalls()).toHaveLength(0);
  });

  it('reports a REST Bot account as a bot', async () => {
    const { octokit } = octokitWith({ response: { data: { id: 8, login: 'app[bot]', type: 'Bot' } } });
    expect(await resolveSelfIdentity(octokit as never)).toEqual({ id: 8, login: 'app[bot]', kind: 'bot' });
  });

  it('falls back to the GraphQL Bot viewer on an installation-token 403 and adds the [bot] suffix', async () => {
    const { octokit, graphqlCalls } = octokitWith(
      { fail: INTEGRATION_403() },
      { response: { viewer: { __typename: 'Bot', login: 'my-app', databaseId: 555 } } },
    );
    expect(await resolveSelfIdentity(octokit as never)).toEqual({ id: 555, login: 'my-app[bot]', kind: 'bot' });
    expect(graphqlCalls()).toHaveLength(1);
    expect(String(graphqlCalls()[0][1])).toContain('viewer');
  });

  it('keeps an existing [bot] suffix and leaves the id unknown when GraphQL omits it', async () => {
    const { octokit } = octokitWith(
      { fail: INTEGRATION_403() },
      { response: { viewer: { __typename: 'Bot', login: 'my-app[bot]', databaseId: null } } },
    );
    expect(await resolveSelfIdentity(octokit as never)).toEqual({ id: undefined, login: 'my-app[bot]', kind: 'bot' });
  });

  it('rethrows the original 403 when the GraphQL viewer is a user, not a bot', async () => {
    const original = INTEGRATION_403();
    const { octokit } = octokitWith(
      { fail: original },
      { response: { viewer: { __typename: 'User', login: 'octo', databaseId: 7 } } },
    );
    await expect(resolveSelfIdentity(octokit as never)).rejects.toBe(original);
  });

  it('rethrows the original 403 when a non-Bot viewer has a [bot]-suffixed login', async () => {
    const original = INTEGRATION_403();
    const { octokit } = octokitWith(
      { fail: original },
      { response: { viewer: { __typename: 'User', login: 'x[bot]' } } },
    );
    await expect(resolveSelfIdentity(octokit as never)).rejects.toBe(original);
  });

  it('rethrows the original 403 when the GraphQL viewer has no login', async () => {
    const original = INTEGRATION_403();
    const { octokit } = octokitWith({ fail: original }, { response: { viewer: { __typename: 'Bot', login: '' } } });
    await expect(resolveSelfIdentity(octokit as never)).rejects.toBe(original);
  });

  it('rethrows the original 403 when the client has no GraphQL', async () => {
    const original = INTEGRATION_403();
    const octokit = { rest: { users: { getAuthenticated: () => Promise.reject(original) } } };
    await expect(resolveSelfIdentity(octokit as never)).rejects.toBe(original);
  });

  it.each([
    [401, 'Bad credentials'],
    [500, 'Server Error'],
  ])('rethrows a REST %i without asking GraphQL', async (status, message) => {
    const original = httpError(status, message);
    const { octokit, graphqlCalls } = octokitWith({ fail: original });
    await expect(resolveSelfIdentity(octokit as never)).rejects.toBe(original);
    expect(graphqlCalls()).toHaveLength(0);
  });

  it('rethrows a network error without a status', async () => {
    const { octokit, graphqlCalls } = octokitWith({ fail: new Error('ECONNRESET') });
    await expect(resolveSelfIdentity(octokit as never)).rejects.toThrow('ECONNRESET');
    expect(graphqlCalls()).toHaveLength(0);
  });

  it('throws when the GraphQL fallback itself fails', async () => {
    const { octokit } = octokitWith({ fail: INTEGRATION_403() }, { fail: 'graphql unavailable' });
    await expect(resolveSelfIdentity(octokit as never)).rejects.toThrow('graphql unavailable');
  });
});

describe('isOwnComment', () => {
  const user: SelfIdentity = { id: 7, login: 'octo', kind: 'user' };
  const bot: SelfIdentity = { id: 555, login: 'my-app[bot]', kind: 'bot' };
  const botNoId: SelfIdentity = { id: undefined, login: 'my-app[bot]', kind: 'bot' };

  it('matches by id when the id is known', () => {
    expect(isOwnComment({ id: 7, login: 'renamed', type: 'User' }, user)).toBe(true);
    expect(isOwnComment({ id: 8, login: 'octo', type: 'User' }, user)).toBe(false);
    expect(isOwnComment({ id: 555, login: 'my-app[bot]', type: 'Bot' }, bot)).toBe(true);
    expect(isOwnComment({ id: 556, login: 'my-app[bot]', type: 'Bot' }, bot)).toBe(false);
  });

  it('without an id, matches only the exact bot login on a Bot author', () => {
    expect(isOwnComment({ id: 555, login: 'my-app[bot]', type: 'Bot' }, botNoId)).toBe(true);
    expect(isOwnComment({ id: 1, login: 'other-app[bot]', type: 'Bot' }, botNoId)).toBe(false);
    expect(isOwnComment({ id: 2, login: 'my-app[bot]', type: 'User' }, botNoId)).toBe(false);
    expect(isOwnComment({ id: 3, login: 'my-app', type: 'Bot' }, botNoId)).toBe(false);
  });

  it('never matches a missing author or an id-less user identity', () => {
    expect(isOwnComment(null, user)).toBe(false);
    expect(isOwnComment(undefined, bot)).toBe(false);
    expect(isOwnComment({ login: 'octo', type: 'User' }, { id: undefined, login: 'octo', kind: 'user' })).toBe(false);
  });
});
