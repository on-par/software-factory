// src/utils/github-identity.test.ts — self identity for user tokens and GitHub App installation tokens
import { describe, expect, it } from 'vitest';

import { createSimOctokit, type SimOctokitStep } from '../fakes/octokit.js';
import { isOwnComment, resolveSelfIdentity, type SelfIdentity } from './github-identity.js';

const httpError = (status: number, message: string): Error => Object.assign(new Error(message), { status });
const INTEGRATION_403 = (): Error => httpError(403, 'Resource not accessible by integration');
const viewer = (fields: Record<string, unknown>): SimOctokitStep => ({ response: { viewer: fields } });

function octokitWith(rest: SimOctokitStep, graphql?: SimOctokitStep, byUsername?: SimOctokitStep) {
  const { octokit, calls } = createSimOctokit({
    endpoints: {
      'users.getAuthenticated': [rest],
      ...(graphql ? { graphql: [graphql] } : {}),
      ...(byUsername ? { 'users.getByUsername': [byUsername] } : {}),
    },
  });
  const callsTo = (name: string) => calls.filter((c) => c[0] === name);
  return { octokit, graphqlCalls: () => callsTo('graphql'), lookups: () => callsTo('users.getByUsername') };
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

  it('asks GraphQL only for fields that exist on User, the schema type of viewer', async () => {
    const { octokit, graphqlCalls } = octokitWith(
      { fail: INTEGRATION_403() },
      viewer({ login: 'my-app[bot]', databaseId: 555 }),
    );
    await resolveSelfIdentity(octokit as never);
    expect(graphqlCalls()).toHaveLength(1);
    const query = String(graphqlCalls()[0][1]);
    expect(query.replace(/\s+/g, ' ')).toBe('query { viewer { login databaseId } }');
    expect(query).not.toMatch(/\bon Bot\b|__typename/);
  });

  it('accepts a [bot] viewer with a database id on an installation-token 403, without a REST lookup', async () => {
    const { octokit, lookups } = octokitWith(
      { fail: INTEGRATION_403() },
      viewer({ login: 'my-app[bot]', databaseId: 555 }),
    );
    expect(await resolveSelfIdentity(octokit as never)).toEqual({ id: 555, login: 'my-app[bot]', kind: 'bot' });
    expect(lookups()).toHaveLength(0);
  });

  it('accepts a suffix-less viewer only when REST names the [bot] account a Bot with the same id', async () => {
    const { octokit, lookups } = octokitWith(
      { fail: INTEGRATION_403() },
      viewer({ login: 'my-app', databaseId: 555 }),
      { response: { data: { id: 555, login: 'my-app[bot]', type: 'Bot' } } },
    );
    expect(await resolveSelfIdentity(octokit as never)).toEqual({ id: 555, login: 'my-app[bot]', kind: 'bot' });
    expect(lookups()).toEqual([['users.getByUsername', { username: 'my-app[bot]' }]]);
  });

  it.each([
    ['a plain user', { id: 7, login: 'octo[bot]', type: 'User' }],
    ['a Bot with another id', { id: 556, login: 'octo[bot]', type: 'Bot' }],
    ['a Bot without a login', { id: 7, type: 'Bot' }],
  ])('rethrows the original 403 when REST names the suffix-less [bot] account %s', async (_label, data) => {
    const original = INTEGRATION_403();
    const { octokit } = octokitWith({ fail: original }, viewer({ login: 'octo', databaseId: 7 }), {
      response: { data },
    });
    await expect(resolveSelfIdentity(octokit as never)).rejects.toBe(original);
  });

  it('rethrows the original 403 when a suffix-less viewer has no [bot] account (404)', async () => {
    const original = INTEGRATION_403();
    const { octokit } = octokitWith({ fail: original }, viewer({ login: 'octo', databaseId: 7 }), {
      fail: httpError(404, 'Not Found'),
    });
    await expect(resolveSelfIdentity(octokit as never)).rejects.toBe(original);
  });

  it('throws when the REST lookup of a suffix-less viewer fails for another reason', async () => {
    const outage = httpError(502, 'Bad Gateway');
    const { octokit } = octokitWith({ fail: INTEGRATION_403() }, viewer({ login: 'octo', databaseId: 7 }), {
      fail: outage,
    });
    await expect(resolveSelfIdentity(octokit as never)).rejects.toBe(outage);
  });

  it.each([
    ['null', null],
    ['missing', undefined],
    ['a string', '555'],
  ])('rethrows the original 403 when the database id is %s, without a REST lookup', async (_label, databaseId) => {
    const original = INTEGRATION_403();
    const { octokit, lookups } = octokitWith({ fail: original }, viewer({ login: 'my-app[bot]', databaseId }));
    await expect(resolveSelfIdentity(octokit as never)).rejects.toBe(original);
    expect(lookups()).toHaveLength(0);
  });

  it.each([
    ['an empty login', { login: '', databaseId: 555 }],
    ['a non-string login', { login: 42, databaseId: 555 }],
  ])('rethrows the original 403 when the viewer has %s', async (_label, fields) => {
    const original = INTEGRATION_403();
    const { octokit } = octokitWith({ fail: original }, viewer(fields));
    await expect(resolveSelfIdentity(octokit as never)).rejects.toBe(original);
  });

  it('rethrows the original 403 when GraphQL returns no viewer', async () => {
    const original = INTEGRATION_403();
    const { octokit } = octokitWith({ fail: original }, { response: {} });
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

  it('throws the GraphQL validation error instead of an identity (fails closed)', async () => {
    const invalid = Object.assign(
      new Error("Request failed due to following response errors:\n - Fragment on Bot can't be spread inside User"),
      {
        errors: [
          { message: "Fragment on Bot can't be spread inside User", extensions: { code: 'cannotSpreadFragment' } },
        ],
      },
    );
    const { octokit } = octokitWith({ fail: INTEGRATION_403() }, { fail: invalid });
    await expect(resolveSelfIdentity(octokit as never)).rejects.toBe(invalid);
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
