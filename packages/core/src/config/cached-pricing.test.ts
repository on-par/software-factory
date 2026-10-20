import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadModelsConfig } from './index.js';
import { applyRepoConfig } from './repo.js';

const directory = await mkdtemp(join(tmpdir(), 'factory-cached-pricing-'));
afterEach(async () => rm(directory, { recursive: true, force: true }));

describe('legacy cached input price config', () => {
  it('preserves an explicit zero rate and accepts an absent rate', async () => {
    const base = {
      provider: 'anthropic',
      tier: 'boss',
      costPerMtokInput: 1,
      costPerMtokOutput: 2,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    };
    const path = join(directory, 'models.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        models: { priced: { ...base, costPerMtokCachedInput: 0 }, ordinary: base },
        tiers: { boss: ['priced', 'ordinary'] },
        failover: { triggers: [], maxRetries: 0, cooldownMs: 0, escalateAfterTierExhausted: false },
      }),
    );
    const loaded = loadModelsConfig(path);
    expect(loaded.models.priced?.costPerMtokCachedInput).toBe(0);
    expect(loaded.models.ordinary).not.toHaveProperty('costPerMtokCachedInput');
  });

  it('preserves cached input rates when applying repo registry entries', () => {
    const config = applyRepoConfig(loadModelsConfig(), {
      version: 2,
      models: {
        registry: {
          'custom-cached': {
            provider: 'custom',
            tier: 'worker',
            costPerMtokInput: 1,
            costPerMtokOutput: 2,
            costPerMtokCachedInput: 0,
            contextWindow: 1000,
            capabilities: [],
            envKey: null,
          },
        },
      },
    });
    expect(config.models['custom-cached']?.costPerMtokCachedInput).toBe(0);
  });
});
