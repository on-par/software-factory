// packages/cli/src/cli/run-claim-settle.test.ts — factory run passes queue.claim_settle_ms to the lane queue (#3239)

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { Octokit } from '@octokit/rest';
import { loadFactoryConfig, loadModelsConfig, loadRepoConfig, resolveEffectiveModelPins } from '@on-par/factory-core';
import type { FactoryConfig } from '@on-par/factory-core';
import type { QueueBackend } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdRun } from './run.js';
import type { RunRuntime } from './run.js';

class StopAtPlan extends Error {}

describe('factory run lane queue (#3239, #3890)', () => {
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
  async function laneQueueFor(
    factoryConfig: FactoryConfig,
    overrides: Partial<RunRuntime> = {},
  ): Promise<QueueBackend> {
    let built: QueueBackend | undefined;
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

  it('factory run hands planRunLanes a GitHub QueueBackend built from the queue config', async () => {
    // The seam does not expose claimSettleMs (no claim path sleeps on it yet), so only the shape is observable.
    const config = {
      ...loadFactoryConfig(),
      queue: { claim_settle_ms: 500, max_review_rework_runs: 2, maxClockSkewMs: 60000, discovery_interval_ms: 60000, stackOnOpenPrerequisite: true },
    };
    const backend = await laneQueueFor(config);
    expect(typeof backend.claimNext).toBe('function');
    expect(typeof backend.lanes).toBe('function');
  });

  it('factory run hands planRunLanes a Linear QueueBackend when tracker.kind is linear', async () => {
    vi.stubEnv('LINEAR_API_KEY', 'lin_test_key');
    // The startup reap lists leased issues; an offline 500 is logged by the lifecycle, never thrown.
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 500 }));
    try {
      const getOctokit = vi.fn(() => {
        throw new Error('GitHub must not be used in Linear mode');
      });
      const reapExpiredClaims = vi.fn(async () => {});
      const config = {
        ...loadFactoryConfig(),
        tracker: {
          kind: 'linear',
          linear: {
            teamKey: 'ON',
            projects: { Foreman: 'o/r' },
            readyLabel: 'factory:ready',
            laneLabelGroup: 'lane',
            states: { ready: 'Todo', inProgress: 'In Progress', parked: 'Todo' },
          },
        },
      } as FactoryConfig;
      const backend = await laneQueueFor(config, {
        getOctokit,
        reapExpiredClaims,
      });
      expect(await backend.pollBlockedParks()).toEqual([]);
      expect(getOctokit).not.toHaveBeenCalled();
      expect(reapExpiredClaims).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it('builds the lane queue when the config has no queue key', async () => {
    const config: Partial<FactoryConfig> = { ...loadFactoryConfig() };
    delete config.queue;
    const backend = await laneQueueFor(config as FactoryConfig);
    expect(typeof backend.heartbeat).toBe('function');
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
