import { Octokit } from '@octokit/rest';
import { describe, expect, it } from 'vitest';

import { resolveSelfIdentity } from './github-identity.js';

const token = process.env.FACTORY_LIVE_GITHUB_TOKEN ?? '';
const live = process.env.GITHUB_ACTIONS === 'true' && token !== '';
const ACTIONS_BOT = 'github-actions[bot]';

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
