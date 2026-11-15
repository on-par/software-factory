import { readFileSync } from 'node:fs';

import { Octokit } from '@octokit/rest';
import {
  createGitHubCredentialBroker,
  installGitHubScopeGuard,
  PhaseCredentialHolder,
  type resolveGitHubCredentialSource,
} from '@on-par/factory-core/internal';
import { describe, expect, it } from 'vitest';

import { createLocalOctokit, credentialSourceOf } from './github-scope.js';
import { shipGitHubScope } from './ship-github-scope.js';
import { defaultOctokit, h, installShipHarness, paths, shipIssue } from './test-support/ship-harness.js';

installShipHarness();

type CredentialSource = ReturnType<typeof resolveGitHubCredentialSource>['source'];

const ctx = () => ({ repoRoot: h.repoRoot, ghRepo: h.ghRepo });

const plainOctokit = (): Octokit => Object.assign(new Octokit(), defaultOctokit());

function guardedFake(releases: string[]) {
  const source: CredentialSource = {
    kind: 'fine-grained',
    async lease(phase) {
      return {
        phase,
        kind: 'fine-grained',
        token: `tok-${phase}`,
        release: async () => {
          releases.push(phase);
        },
      };
    },
  };
  const holder = new PhaseCredentialHolder(createGitHubCredentialBroker({ repo: h.ghRepo, source }), {
    checkToken: () => undefined,
  });
  const octokit = installGitHubScopeGuard(plainOctokit(), { repo: h.ghRepo, holder });
  return { octokit, holder };
}

describe('ship credential phases', () => {
  it('enters the matching credential phase on each run phase without changing the phase order', async () => {
    const releases: string[] = [];
    const { octokit, holder } = guardedFake(releases);
    const observed: Array<string | undefined> = [];
    const probe = <T>(result: T) => {
      return async (): Promise<T> => {
        observed.push(holder.current()?.phase);
        return result;
      };
    };
    const guardedOutcome = await shipIssue(5, {}, ctx(), {
      octokit: () => octokit,
      planPhase: probe(h.planResult),
      buildPhase: probe(h.buildResult),
      checkPhase: probe(h.checkResult),
      shipPhase: probe(h.shipResult),
    });

    const unguardedOrder: Array<string | undefined> = [];
    const unguardedOutcome = await shipIssue(5, {}, ctx(), {
      octokit: plainOctokit,
      planPhase: async () => {
        unguardedOrder.push('plan');
        return h.planResult;
      },
      buildPhase: async () => {
        unguardedOrder.push('build');
        return h.buildResult;
      },
      checkPhase: async () => {
        unguardedOrder.push('check');
        return h.checkResult;
      },
      shipPhase: async () => {
        unguardedOrder.push('ship');
        return h.shipResult;
      },
    });

    expect(observed).toEqual(['plan', 'build', 'check', 'ship']);
    expect(observed).toEqual(unguardedOrder);
    expect(guardedOutcome).toEqual(unguardedOutcome);
    expect(releases).toEqual(['plan', 'ship']);
    expect(holder.current()?.credential).toBeUndefined();
  });

  it('logs no credential source events for an injected client', async () => {
    await shipIssue(5, {}, ctx(), { octokit: plainOctokit });
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).not.toContain('github_credentials');
    expect(credentialSourceOf(defaultOctokit())).toBeUndefined();
  });

  it('logs the credential source kind and the ambient warning, never a token', async () => {
    const eventsFile = paths().events;
    const shell = {
      execSync: () => {
        throw new Error('unavailable');
      },
    };
    let deprecationLog: ((d: { method: string; route: string }) => void) | undefined;
    const scope = shipGitHubScope(
      undefined,
      (options) => {
        deprecationLog = options.log;
        return createLocalOctokit(shell, () => 'ghp_ambientsecret000001', {}, options);
      },
      { loadFactoryConfigForRepo: () => ({}) },
      { ghRepo: h.ghRepo, issueNum: 5, paths: { config: paths().config, events: eventsFile }, lane: 'lane-1' },
    );
    deprecationLog?.({ method: 'GET', route: '/repos/{owner}/{repo}/old' });
    await scope.close();
    const events = readFileSync(eventsFile, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const byType = (type: string) => events.find((e) => e.type === type);
    expect(byType('github_credentials')).toMatchObject({ lane: 'lane-1' });
    expect(byType('github_credentials').msg).toContain('ambient');
    expect(byType('github_credentials_ambient').msg).toContain('ADR-0160');
    expect(byType('github_api_deprecated')).toBeDefined();
    expect(readFileSync(eventsFile, 'utf-8')).not.toContain('ghp_ambientsecret000001');
  });
});
