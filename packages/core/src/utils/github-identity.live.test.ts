// src/utils/github-identity.live.test.ts — resolveSelfIdentity against real GitHub with a real App installation token.
//
// A GitHub Actions job token is an installation token of the `github-actions` App, so it reproduces exactly what a
// factory running under its own App sees. The CI `static` job passes its `github.token` as
// FACTORY_LIVE_GITHUB_TOKEN. Everywhere else (local runs, test shards, factory runs inside Actions with another
// token) the variable is unset and the suite is skipped. Read-only: GET-style calls only, nothing is written.
//
// The suite logs what GitHub returned for `viewer` (login and databaseId, neither secret; the token is never
// logged), so the CI log records the raw answer the fallback is built on, not only a pass/fail.
import { Octokit } from '@octokit/rest';
import { describe, expect, it } from 'vitest';

import { resolveSelfIdentity } from './github-identity.js';

const token = process.env.FACTORY_LIVE_GITHUB_TOKEN ?? '';
const live = process.env.GITHUB_ACTIONS === 'true' && token !== '';
const ACTIONS_BOT = 'github-actions[bot]';

/** An Octokit that records each request it sends as `METHOD /route-template`, e.g. `GET /users/{username}`. */
function recordingOctokit(): { octokit: Octokit; requests: string[] } {
  const octokit = new Octokit({ auth: token });
  const requests: string[] = [];
  octokit.hook.wrap('request', (request, options) => {
    requests.push(`${options.method} ${options.url}`);
    return request(options);
  });
  return { octokit, requests };
}

describe.skipIf(!live)('resolveSelfIdentity with a GitHub Actions installation token (live)', () => {
  it('is refused REST GET /user, so the GraphQL fallback is what runs', async () => {
    const { octokit } = recordingOctokit();
    await expect(octokit.rest.users.getAuthenticated()).rejects.toMatchObject({ status: 403 });
  });

  it('reports a viewer whose databaseId is the REST user id of its [bot] account', async () => {
    const { octokit } = recordingOctokit();
    const { viewer } = await octokit.graphql<{ viewer: { login: unknown; databaseId: unknown } }>(
      'query { viewer { login databaseId } }',
    );
    const { data: bot } = await octokit.rest.users.getByUsername({ username: ACTIONS_BOT });
    console.log(
      `live viewer provenance: GraphQL viewer.login=${JSON.stringify(viewer.login)} ` +
        `viewer.databaseId=${JSON.stringify(viewer.databaseId)}; REST ${ACTIONS_BOT} id=${bot.id} type=${bot.type}`,
    );
    expect(typeof viewer.login).toBe('string');
    expect(String(viewer.login).replace(/\[bot\]$/, '')).toBe('github-actions');
    expect(bot.type).toBe('Bot');
    expect(viewer.databaseId).toBe(bot.id);
  });

  it('resolves the github-actions bot account through REST 403 -> GraphQL viewer -> REST bot lookup', async () => {
    const { data: bot } = await new Octokit({ auth: token }).rest.users.getByUsername({ username: ACTIONS_BOT });
    const { octokit, requests } = recordingOctokit();
    expect(await resolveSelfIdentity(octokit)).toEqual({ id: bot.id, login: ACTIONS_BOT, kind: 'bot' });
    console.log(`live identity path: ${requests.join(' -> ')}`);
    expect(requests).toEqual(['GET /user', 'POST /graphql', 'GET /users/{username}']);
  });
});
