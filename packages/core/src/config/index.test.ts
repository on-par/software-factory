import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getFactoryPaths, loadFactoryConfig, loadModelsConfig, resolveTimeouts } from './index.js';

function baseModelDef(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'anthropic',
    tier: 'boss',
    costPerMtokInput: 0,
    costPerMtokOutput: 0,
    contextWindow: 1000,
    capabilities: [],
    envKey: null,
    ...overrides,
  };
}

function writeModelsConfig(dir: string, harness?: string) {
  const config = {
    version: 1,
    models: {
      'some-model': baseModelDef(harness !== undefined ? { harness } : {}),
    },
    tiers: { boss: ['some-model'] },
    failover: {
      triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
      maxRetries: 2,
      cooldownMs: 0,
      escalateAfterTierExhausted: true,
    },
    routingRules: {},
  };
  const path = join(dir, 'models.json');
  return writeFile(path, JSON.stringify(config)).then(() => path);
}

describe('getFactoryPaths', () => {
  it('stages triage output alongside the live queue path', () => {
    const repoRoot = '/tmp/some-repo';
    const paths = getFactoryPaths(repoRoot);
    expect(paths.queue).toBe(resolve(repoRoot, '.factory', 'queue'));
    expect(paths.queueProposed).toBe(resolve(repoRoot, '.factory', 'queue.proposed'));
    expect(paths.mergeLock).toBe(resolve(repoRoot, '.factory', 'merge.lock'));
    expect(paths.gitLock).toBe(resolve(repoRoot, '.factory', 'git.lock'));
    expect(paths.approvals).toBe(resolve(repoRoot, '.factory', 'approvals'));
  });
});

describe('loadModelsConfig', () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('parses the shipped models.json without throwing', () => {
    expect(() => loadModelsConfig()).not.toThrow();
  });

  it('throws naming the model and the unknown harness id', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-models-config-'));
    const path = await writeModelsConfig(tmpDir, 'not-a-harness');

    expect(() => loadModelsConfig(path)).toThrow(/some-model.*not-a-harness/s);
  });

  it('parses a model declaring a known harness id', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-models-config-'));
    const path = await writeModelsConfig(tmpDir, 'claude-cli');

    expect(() => loadModelsConfig(path)).not.toThrow();
  });

  it('parses a model declaring harness opencode', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-models-config-'));
    const path = await writeModelsConfig(tmpDir, 'opencode');

    expect(() => loadModelsConfig(path)).not.toThrow();
  });

  it('parses a model with no harness declared', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-models-config-'));
    const path = await writeModelsConfig(tmpDir);

    expect(() => loadModelsConfig(path)).not.toThrow();
  });

  it('lists every model referenced by a tier in the models map', () => {
    const config = loadModelsConfig();
    for (const models of Object.values(config.tiers)) {
      for (const modelId of models) {
        expect(config.models[modelId]).toBeDefined();
      }
    }
  });

  it('routes to only real, non-experimental models by default', () => {
    const config = loadModelsConfig();
    const nonExperimental = Object.entries(config.models)
      .filter(([, def]) => !def.experimental)
      .map(([id]) => id)
      .sort();
    expect(nonExperimental).toEqual(
      [
        'claude-fable-5',
        'claude-opus-4-8',
        'claude-sonnet-5',
        'codex-ollama-qwen3.5:9b',
        'gemma4:12b',
        'gpt-5.1-codex',
        'gpt-5.6-sol',
        'qwen2.5-coder:14b',
        'qwen3.5:9b',
        'qwen3:8b',
      ].sort(),
    );
  });
});

describe('loadFactoryConfig', () => {
  it('parses the shipped factory.json without throwing', () => {
    expect(() => loadFactoryConfig()).not.toThrow();
  });

  it('shipped config has worktree gc defaults', () => {
    const config = loadFactoryConfig();
    expect(config.worktree.gcTtlDays).toBe(7);
    expect(config.worktree.autoGcOnRun).toBe(true);
  });

  it('shipped config sets a 1800s approval timeout', () => {
    const config = loadFactoryConfig();
    expect(config.timeouts.approval_seconds).toBe(1800);
  });

  it('applies worktree gc defaults when the config omits them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'factory-config-'));
    try {
      const path = join(dir, 'factory.json');
      const minimal = {
        version: 1,
        paths: {
          constitutions: 'constitutions/',
          checkers: 'lib/checkers/',
          plans: '.factory/plans/',
          logs: '.factory/logs/',
          events: '.factory/events.ndjson',
        },
        timeouts: { plan_seconds: 1800, build_seconds: 7200, check_seconds: 1800, merge_poll_seconds: 120 },
        merge: { auto: false, comment: '' },
        worktree: { prefix: 'ship-it/', parent: '../', comment: '' },
        byok: { enabled: false, comment: '' },
        notifications: {},
        cost_tracking: { enabled: true, log_file: '.factory/costs.jsonl', comment: '' },
      };
      await writeFile(path, JSON.stringify(minimal));
      const config = loadFactoryConfig(path);
      expect(config.worktree.gcTtlDays).toBe(7);
      expect(config.worktree.autoGcOnRun).toBe(true);
      expect(config.timeouts.approval_seconds).toBe(1800);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveTimeouts', () => {
  it('uses config values when env overrides are absent', () => {
    const config = loadFactoryConfig();
    expect(
      resolveTimeouts(
        {
          ...config,
          timeouts: { ...config.timeouts, plan_seconds: 900 },
        },
        {},
      ).plan,
    ).toBe(900);
  });

  it('lets env override config values', () => {
    const config = loadFactoryConfig();
    expect(
      resolveTimeouts(
        {
          ...config,
          timeouts: { ...config.timeouts, build_seconds: 7200 },
        },
        { FACTORY_BUILD_TIMEOUT: '3600' },
      ).build,
    ).toBe(3600);
  });

  it('preserves defaults and ignores invalid env values', () => {
    const config = loadFactoryConfig();

    expect(resolveTimeouts(config, {})).toEqual({ plan: 1800, build: 7200, check: 1800, approval: 1800 });
    expect(
      resolveTimeouts(config, {
        FACTORY_PLAN_TIMEOUT: 'abc',
        FACTORY_CHECK_TIMEOUT: '',
      }),
    ).toEqual({ plan: 1800, build: 7200, check: 1800, approval: 1800 });
  });

  it('honors approval_seconds from config', () => {
    const config = loadFactoryConfig();
    expect(
      resolveTimeouts(
        {
          ...config,
          timeouts: { ...config.timeouts, approval_seconds: 900 },
        },
        {},
      ).approval,
    ).toBe(900);
  });

  it('lets FACTORY_APPROVAL_TIMEOUT override config', () => {
    const config = loadFactoryConfig();
    expect(resolveTimeouts(config, { FACTORY_APPROVAL_TIMEOUT: '60' }).approval).toBe(60);
  });
});
