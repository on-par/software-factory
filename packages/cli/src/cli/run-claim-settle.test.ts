// packages/cli/src/cli/run-claim-settle.test.ts — factory run passes queue.claim_settle_ms to the lane queue (#3239)

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { Octokit } from '@octokit/rest';
import { defaultFactoryConfig } from '@on-par/factory-config';
import { loadFactoryConfig, loadModelsConfig, loadRepoConfig, resolveEffectiveModelPins } from '@on-par/factory-core';
import type { FactoryConfig } from '@on-par/factory-core';
import type { GithubQueue } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cmdRun } from './run.js';
import type { RunRuntime } from './run.js';

class StopAtPlan extends Error {}

describe('factory run claim settle delay (#3239)', () => {
  const temp = createTempDirs();
  let root: string;

  beforeEach(() => {
    root = temp.makeSync('run-claim-settle-');
    mkdirSync(join(root, '.factory'), { recursive: true });
  });

  afterEach(async () => {
    await temp.cleanup();
  });

  /** Runs cmdRun up to planRunLanes and builds the lane queue it would hand over. */
  async function laneQueueFor(factoryConfig: FactoryConfig, overrides: Partial<RunRuntime> = {}): Promise<GithubQueue> {
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
      sweepOrphanDrafts: async () => {},
      reapExpiredClaims: async () => {},
      planRunLanes: async (input) => {
        built = input.queue();
        throw new StopAtPlan('stop');
      },
      ...overrides,
    };
    // cmdRun stops at planRunLanes, so only the members above are ever read.
    const rt = partial as RunRuntime;
    await expect(cmdRun({}, rt)).rejects.toBeInstanceOf(StopAtPlan);
    if (!built) throw new Error('lane queue was not built');
    return built;
  }

  it('factory run builds the lane queue with claimSettleMs from queue.claim_settle_ms', async () => {
    const config = {
      ...loadFactoryConfig(),
      queue: { claim_settle_ms: 500, max_review_rework_runs: 2, maxClockSkewMs: 60000 },
    };
    expect((await laneQueueFor(config)).claimSettleMs).toBe(500);
  });

  it('falls back to the packaged default when the config has no queue key', async () => {
    const config: Partial<FactoryConfig> = { ...loadFactoryConfig() };
    delete config.queue;
    expect((await laneQueueFor(config as FactoryConfig)).claimSettleMs).toBe(
      defaultFactoryConfig.queue.claim_settle_ms,
    );
  });

  it('cmdRun runs the orphan draft sweep after the lane-claim sweep', async () => {
    const calls: string[] = [];
    const base = { ...loadFactoryConfig() };
    await laneQueueFor(base, {
      sweepStaleLaneClaims: async () => {
        calls.push('claims');
      },
      sweepOrphanDrafts: async () => {
        calls.push('drafts');
      },
      planRunLanes: async () => {
        calls.push('plan');
        throw new StopAtPlan('stop');
      },
    }).catch(() => undefined);
    expect(calls).toEqual(['claims', 'drafts', 'plan']);
  });
});
