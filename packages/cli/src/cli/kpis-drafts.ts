// packages/cli/src/cli/kpis-drafts.ts — open factory drafts for `factory kpis --json` (#3553)

import type { Octokit } from '@octokit/rest';
import { readOpenFactoryDrafts } from '@on-par/factory-core/internal';
import type { OpenFactoryDrafts } from '@on-par/factory-core/internal';

/** Null when the repo or the PR listing cannot be read. */
export async function readKpisDrafts(
  gh: { getGitHubRepo: () => Promise<string>; getOctokit: () => Octokit },
  prefix: string,
): Promise<OpenFactoryDrafts | null> {
  try {
    const [owner, repo] = (await gh.getGitHubRepo()).split('/');
    return await readOpenFactoryDrafts({ octokit: gh.getOctokit(), owner, repo, prefix });
  } catch {
    return null;
  }
}
