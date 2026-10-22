// packages/cli/src/cli/run-claim-settle.test.ts — factory run passes queue.claim_settle_ms to the lane queue (#3239)

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Octokit } from '@octokit/rest';
import { defaultFactoryConfig } from '@on-par/factory-config';
import { loadFactoryConfig, loadModelsConfig, loadRepoConfig, resolveEffectiveModelPins } from '@on-par/factory-core';
import type { FactoryConfig } from '@on-par/factory-core';
import type { GithubQueue } from '@on-par/factory-core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cmdRun } from './run.js';
import type { RunRuntime } from './run.js';

class StopAtPlan extends Error {}

describe('factory run claim settle delay (#3239)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'run-claim-settle-'));
    mkdirSync(join(root, '.factory'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Runs cmdRun up to planRunLanes and builds the lane queue it would hand over. */
  async function laneQueueFor(factoryConfig: FactoryConfig): Promise<GithubQueue> {
    let built: GithubQueue | undefined;
    const partial: Partial<RunRuntime> = {
      configLoaders: {
        loadModelsConfig,
        loadRepoConfig,
        resolveEffectiveModelPins,
        loadFactoryConfigForRepo: () => factoryConfig,
      },
      getRepoRoot: async () => root,
      getGitHubRepo: async () => 'o/r',
      getOctokit: () => new Octokit(),
      branchPrefixOrExit: () => 'factory',
      withRepoRunLock: async (_paths, _name, fn) => fn(),
      probeClaudeKeychain: () => ({ status: 'skipped', detail: 'test' }),
      runAutoWorktreeGc: async () => {},
      sweepStaleLaneClaims: async () => {},
      planRunLanes: async (input) => {
        built = input.queue();
        throw new StopAtPlan('stop');
      },
    };
    // cmdRun stops at planRunLanes, so only the members above are ever read.
    const rt = partial as RunRuntime;
    await expect(cmdRun({}, rt)).rejects.toBeInstanceOf(StopAtPlan);
    if (!built) throw new Error('lane queue was not built');
    return built;
  }

  it('factory run builds the lane queue with claimSettleMs from queue.claim_settle_ms', async () => {
    const config = { ...loadFactoryConfig(), queue: { claim_settle_ms: 500 } };
    expect((await laneQueueFor(config)).claimSettleMs).toBe(500);
  });

  it('falls back to the packaged default when the config has no queue key', async () => {
    const config: Partial<FactoryConfig> = { ...loadFactoryConfig() };
    delete config.queue;
    expect((await laneQueueFor(config as FactoryConfig)).claimSettleMs).toBe(
      defaultFactoryConfig.queue.claim_settle_ms,
    );
  });
});
