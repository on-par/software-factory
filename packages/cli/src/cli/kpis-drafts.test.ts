// packages/cli/src/cli/kpis-drafts.test.ts — cover readKpisDrafts catch → null
import type { Octokit } from '@octokit/rest';
import { describe, expect, it } from 'vitest';

import { readKpisDrafts } from './kpis-drafts.js';

describe('readKpisDrafts', () => {
  it('returns null when the repo cannot be read', async () => {
    const gh = {
      getGitHubRepo: async () => {
        throw new Error('no remote');
      },
      getOctokit: () => ({}) as Octokit,
    };
    await expect(readKpisDrafts(gh, 'factory/')).resolves.toBeNull();
  });
});
