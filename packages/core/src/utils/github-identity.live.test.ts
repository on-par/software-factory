// src/utils/github-identity.live.test.ts — resolveSelfIdentity against real GitHub with a real App installation token.
//
// A GitHub Actions job token is an installation token of the `github-actions` App, so it reproduces exactly what a
// factory running under its own App sees. The CI `static` job passes its `github.token` as
// FACTORY_LIVE_GITHUB_TOKEN. Everywhere else (local runs, test shards, factory runs inside Actions with another
// token) the variable is unset and the suite is skipped. Read-only: three GET-style calls, nothing is written.
import { Octokit } from '@octokit/rest';
import { describe, expect, it } from 'vitest';

import { resolveSelfIdentity } from './github-identity.js';

const token = process.env.FACTORY_LIVE_GITHUB_TOKEN ?? '';
const live = process.env.GITHUB_ACTIONS === 'true' && token !== '';
const ACTIONS_BOT = 'github-actions[bot]';

describe.skipIf(!live)('resolveSelfIdentity with a GitHub Actions installation token (live)', () => {
  const octokit = new Octokit({ auth: token });

  it('is refused REST GET /user, so the GraphQL fallback is what runs', async () => {
    await expect(octokit.rest.users.getAuthenticated()).rejects.toMatchObject({ status: 403 });
  });

  it('resolves the github-actions bot account with its REST user id', async () => {
    const { data: bot } = await octokit.rest.users.getByUsername({ username: ACTIONS_BOT });
    expect(bot.type).toBe('Bot');
    expect(await resolveSelfIdentity(octokit)).toEqual({ id: bot.id, login: ACTIONS_BOT, kind: 'bot' });
  });
});
