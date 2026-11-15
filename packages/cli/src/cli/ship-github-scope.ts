import type { Octokit } from '@octokit/rest';
import type { FailurePhase } from '@on-par/factory-core';
import { logEvent, phaseHolderOf, resolveGitHubCredentialsConfig } from '@on-par/factory-core/internal';
import type { PhaseCredentialHolder } from '@on-par/factory-core/internal';
import { credentialSourceOf, type ScopedOctokitOptions } from './github-scope.js';
import { formatDeprecation } from './octokit.js';

export interface ShipGitHubScope {
  octokit: Octokit;
  recordPhase: (recorder: (phase: FailurePhase) => Promise<void>) => (phase: FailurePhase) => Promise<void>;
  close: () => Promise<void>;
}

export function shipGitHubScope(
  injected: (() => Octokit) | undefined,
  getOctokit: (options: ScopedOctokitOptions) => Octokit,
  loaders: { loadFactoryConfigForRepo: (configPath: string) => Parameters<typeof resolveGitHubCredentialsConfig>[0] },
  run: { ghRepo: string; issueNum: number; paths: { config: string; events: string }; lane?: string },
): ShipGitHubScope {
  const { ghRepo, issueNum, paths, lane } = run;
  const eventsFile = paths.events;
  const octokit =
    injected?.() ??
    getOctokit({
      log: (d) => logEvent(eventsFile, 'github_api_deprecated', issueNum, formatDeprecation(d), { lane }),
      phase: 'plan',
      repo: ghRepo,
      settings: resolveGitHubCredentialsConfig(loaders.loadFactoryConfigForRepo(paths.config)),
    });
  const holder: PhaseCredentialHolder | undefined = phaseHolderOf(octokit);
  const source = credentialSourceOf(octokit);
  if (source) {
    logEvent(eventsFile, 'github_credentials', issueNum, `GitHub credential source: ${source.source.kind}`, { lane });
    if (source.warning) logEvent(eventsFile, 'github_credentials_ambient', issueNum, source.warning, { lane });
  }
  return {
    octokit,
    recordPhase: (recorder) => async (phase) => {
      await holder?.enter(phase);
      await recorder(phase);
    },
    close: async () => {
      await holder?.close();
    },
  };
}
