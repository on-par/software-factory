import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getConstitutionsDir,
  getFactoryPaths,
  loadFactoryConfig,
  loadFactoryConfigForRepo,
  loadModelsConfig,
  loadRoutesConfig,
  resolveAutoFailover,
  resolveBranchPrefix,
  resolveDefectWindowDays,
  resolveEnvironmentPorts,
  resolveEnvironmentProxy,
  resolveExperimental,
  resolveFilingPolicy,
  resolveIngestConfig,
  resolveLocalOnly,
  resolvePlanApproval,
  resolveProcessGroupGraceMs,
  resolveSkipCI,
  resolveTimeouts,
} from './index.js';

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
    expect(paths.runLock).toBe(resolve(repoRoot, '.factory', 'run.lock'));
    expect(paths.approvals).toBe(resolve(repoRoot, '.factory', 'approvals'));
    expect(paths.kpiHistory).toBe(resolve(repoRoot, '.factory', 'kpi-history.jsonl'));
    expect(paths.ingestWatermark).toBe(resolve(repoRoot, '.factory', 'ingest-watermark'));
    expect(paths.ports).toBe(resolve(repoRoot, '.factory', 'ports.json'));
    expect(paths.portsLock).toBe(resolve(repoRoot, '.factory', 'ports.lock'));
    expect(paths.proxyState).toBe(resolve(repoRoot, '.factory', 'proxy.json'));
    expect(paths.breaker).toBe(resolve(repoRoot, '.factory', 'breaker.json'));
    expect(paths.reworkHistory).toBe(resolve(repoRoot, '.factory', 'rework-history.json'));
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

  it('parses the shipped model defaults without throwing', () => {
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
        'claude-opus-5',
        'claude-sonnet-5',
        'gemma4:12b',
        'gpt-5.1-codex',
        'gpt-5.6-luna-high',
        'gpt-5.6-sol',
        'gpt-5.6-terra-high',
        'gpt-5.6-terra-medium',
        'qwen2.5-coder:14b',
        'qwen3.5:9b',
        'qwen3:8b',
      ].sort(),
    );
  });

  it('quarantines the codex-ollama command-agent spike as an experiment (#172)', () => {
    const config = loadModelsConfig();
    const spike = config.models['codex-ollama-qwen3.5:9b'];
    expect(spike?.experimental).toBe(true);
    expect(spike?.codexFlag).toBeUndefined();
    expect(spike?.harness).toBe('ollama-agentic');
    expect(spike?.codex).toBe(true);
  });

  it('pins -m explicitly on every non-experimental codex-cli model so failover always changes the effective provider config (#415)', () => {
    const config = loadModelsConfig();
    const codexCliModels = Object.entries(config.models).filter(
      ([, def]) => def.harness === 'codex-cli' && !def.experimental,
    );
    expect(codexCliModels.length).toBeGreaterThanOrEqual(2);
    for (const [id, def] of codexCliModels) {
      const flagModel = def.codexFlag?.match(/(?:^|\s)-m (\S+)/)?.[1];
      expect(flagModel, `${id}: codexFlag must pin -m`).toBeDefined();
      // The -m value must be the model's own registry id, or a shared family
      // base that the id extends (e.g. gpt-5.6-terra-high/-medium both pin
      // -m gpt-5.6-terra) — never an unrelated/mistyped model id.
      expect(
        id === flagModel || id.startsWith(`${flagModel}-`),
        `${id}: -m ${flagModel} does not match or extend its own registry id`,
      ).toBe(true);
    }
    const flags = codexCliModels.map(([, def]) => def.codexFlag);
    expect(new Set(flags).size).toBe(flags.length);
  });

  it('pins gpt-5.1-codex explicitly via -m (#415)', () => {
    const config = loadModelsConfig();
    expect(config.models['gpt-5.1-codex']?.codexFlag).toBe('-m gpt-5.1-codex -c model_reasoning_effort=high');
  });

  it('registers default Codex GPT phase profiles: Terra high for plan, Terra medium for build (#529)', () => {
    const config = loadModelsConfig();
    expect(config.models['gpt-5.6-terra-high']?.codexFlag).toBe('-m gpt-5.6-terra -c model_reasoning_effort=high');
    expect(config.models['gpt-5.6-terra-medium']?.codexFlag).toBe('-m gpt-5.6-terra -c model_reasoning_effort=medium');
  });

  it('orders tiers so Terra profiles sit ahead of the generic GPT failover chain without disturbing Claude defaults (#529)', () => {
    const config = loadModelsConfig();
    expect(config.tiers.boss[0]).toBe('claude-opus-5');
    expect(config.tiers.boss).toContain('gpt-5.6-terra-high');

    const workerIdx = (id: string) => config.tiers.worker.indexOf(id);
    expect(workerIdx('gpt-5.6-terra-medium')).toBeGreaterThanOrEqual(0);
    expect(workerIdx('gpt-5.6-terra-medium')).toBeLessThan(workerIdx('gpt-5.6-sol'));
    expect(workerIdx('gpt-5.6-sol')).toBeLessThan(workerIdx('gpt-5.1-codex'));
  });
});

describe('loadFactoryConfig', () => {
  it('parses the shipped factory defaults without throwing', () => {
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

  it('shipped config has a 14-day post-merge defect window', () => {
    const config = loadFactoryConfig();
    expect(config.kpis.defectWindowDays).toBe(14);
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

  it('shipped config has a default-enabled sandbox block', () => {
    const config = loadFactoryConfig();
    expect(config.sandbox.enabled).toBe(true);
    expect(config.sandbox.network.allow).toEqual(['api.anthropic.com', 'github.com']);
    expect(config.sandbox.resources).toEqual({ cpuMs: 300_000, memMb: 4096 });
  });

  it('shipped config has an enabled auto_failover block with a 30 minute cooldown', () => {
    const config = loadFactoryConfig();
    expect(config.auto_failover.enabled).toBe(true);
    expect(config.auto_failover.cooldown_minutes).toBe(30);
    expect(config.auto_failover.fallback_model).toBe('claude-sonnet-5');
  });

  it('applies sandbox defaults when the config omits the sandbox key', async () => {
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
      expect(config.sandbox.enabled).toBe(true);
      expect(config.sandbox.network.allow).toEqual(['api.anthropic.com', 'github.com']);
      expect(config.sandbox.resources).toEqual({ cpuMs: 300_000, memMb: 4096 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves discovery defaults', () => {
    const config = loadFactoryConfig();
    expect(config.discovery.enabled).toBe(true);
    expect(config.discovery.schedule).toBe('weekly');
    expect(config.discovery.maxCandidates).toBe(5);
  });

  it('applies discovery defaults when the config omits the discovery key', async () => {
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
      expect(config.discovery).toEqual({ enabled: true, schedule: 'weekly', maxCandidates: 5 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('parses a discovery override', async () => {
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
        discovery: { enabled: false, schedule: 'daily', maxCandidates: 3 },
      };
      await writeFile(path, JSON.stringify(minimal));
      const config = loadFactoryConfig(path);
      expect(config.discovery).toEqual({ enabled: false, schedule: 'daily', maxCandidates: 3 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const defaultFilingPolicy = {
    enabled: true,
    excludeReasons: ['rate_limit', 'usage_cap', 'timeout', 'verify_failed'],
    repeatThreshold: 3,
    maxPerRun: 5,
    maxPerDay: 20,
    selfFixLabel: 'no-auto-merge',
    bugLabels: ['bug'],
    sensitivePaths: ['packages/core/', 'packages/config/', 'packages/cli/', 'scripts/', '.github/'],
  };

  it('exposes filing defaults from the default config file', () => {
    const config = loadFactoryConfig();
    expect(config.filing.enabled).toBe(true);
    expect(config.filing.excludeReasons).toEqual(['rate_limit', 'usage_cap', 'timeout', 'verify_failed']);
    expect(config.filing.repeatThreshold).toBe(3);
    expect(config.filing.maxPerRun).toBe(5);
    expect(config.filing.maxPerDay).toBe(20);
    expect(config.filing.selfFixLabel).toBe('no-auto-merge');
  });

  it('resolveFilingPolicy returns a FilingPolicy matching the config block', () => {
    const config = loadFactoryConfig();
    expect(resolveFilingPolicy(config)).toEqual(defaultFilingPolicy);
  });

  it('applies filing defaults when the config omits the filing key', async () => {
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
      expect(config.filing).toEqual(defaultFilingPolicy);
      expect(resolveFilingPolicy(config)).toEqual(defaultFilingPolicy);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves ingest defaults from the default config file', () => {
    const config = loadFactoryConfig();
    expect(config.ingest.enabled).toBe(false);
    expect(config.ingest.label).toBe('ready');
    expect(config.ingest.lane).toBe('auto');
    expect(config.ingest.maxPerCycle).toBe(20);
  });

  it('applies ingest defaults when the config omits the ingest key', async () => {
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
      expect(config.ingest).toEqual({ enabled: false, label: 'ready', lane: 'auto', maxPerCycle: 20 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('parses an ingest override', async () => {
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
        ingest: { enabled: true, label: 'triaged', lane: 'nightly', maxPerCycle: 3 },
      };
      await writeFile(path, JSON.stringify(minimal));
      const config = loadFactoryConfig(path);
      expect(config.ingest).toEqual({ enabled: true, label: 'triaged', lane: 'nightly', maxPerCycle: 3 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('loadFactoryConfigForRepo', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'factory-config-repo-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the shipped defaults, deep-equal to loadFactoryConfig(), when the path does not exist', () => {
    const path = join(dir, 'does-not-exist.json');
    expect(loadFactoryConfigForRepo(path)).toEqual(loadFactoryConfig());
  });

  it('applies a partial merge.auto override while preserving merge.comment from the defaults', async () => {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ merge: { auto: true } }));
    const config = loadFactoryConfigForRepo(path);
    expect(config.merge.auto).toBe(true);
    expect(config.merge.comment).toBe(loadFactoryConfig().merge.comment);
  });

  it('deep-equals the shipped defaults for a repo-namespace-only file', async () => {
    const path = join(dir, 'config.json');
    await writeFile(
      path,
      JSON.stringify({ version: 1, models: { plan: 'claude-opus-5' }, providers: { openai: false } }),
    );
    expect(loadFactoryConfigForRepo(path)).toEqual(loadFactoryConfig());
  });

  it('merges a mixed file: worktree.gcTtlDays overrides while worktree.prefix stays default', async () => {
    const path = join(dir, 'config.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        models: { plan: 'claude-opus-5' },
        worktree: { gcTtlDays: 30 },
      }),
    );
    const config = loadFactoryConfigForRepo(path);
    expect(config.worktree.gcTtlDays).toBe(30);
    expect(config.worktree.prefix).toBe(loadFactoryConfig().worktree.prefix);
  });

  it('replaces array/tuple fields wholesale rather than merging element-wise', async () => {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ environment: { ports: { range: [4000, 4100] } } }));
    const config = loadFactoryConfigForRepo(path);
    expect(config.environment.ports.range).toEqual([4000, 4100]);
  });

  it('throws an error naming the file path on malformed JSON', async () => {
    const path = join(dir, 'config.json');
    await writeFile(path, '{ not valid json');
    expect(() => loadFactoryConfigForRepo(path)).toThrow(/Failed to parse/);
    expect(() => loadFactoryConfigForRepo(path)).toThrow(path);
  });

  it('throws an error naming the file path and the offending field on a runtime-namespace type violation', async () => {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ merge: { auto: 'yes' } }));
    expect(() => loadFactoryConfigForRepo(path)).toThrow(path);
    expect(() => loadFactoryConfigForRepo(path)).toThrow(/merge\.auto/);
  });

  it('throws "expected a JSON object" when the top level is an array', async () => {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify([1, 2, 3]));
    expect(() => loadFactoryConfigForRepo(path)).toThrow(/expected a JSON object/);
  });

  it('throws "expected a JSON object" when the top level is a string', async () => {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify('nope'));
    expect(() => loadFactoryConfigForRepo(path)).toThrow(/expected a JSON object/);
  });
});

describe('loadRoutesConfig', () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('parses the shipped route defaults without throwing', () => {
    expect(() => loadRoutesConfig()).not.toThrow();
  });

  it('parses a route declaring the optional requires field', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-routes-config-'));
    const path = join(tmpDir, 'routes.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        routes: { build_codex: { tier: 'worker', description: 'stub', requires: 'codex' } },
      }),
    );

    const config = loadRoutesConfig(path);
    expect(config.routes.build_codex.requires).toBe('codex');
  });

  it('throws on an invalid routes schema', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-routes-config-'));
    const path = join(tmpDir, 'routes.json');
    await writeFile(path, JSON.stringify({ version: 1, routes: { plan: { tier: 'boss' } } }));

    expect(() => loadRoutesConfig(path)).toThrow();
  });
});

describe('resolveSkipCI', () => {
  it('is true when FACTORY_SKIP_CI is exactly "1", regardless of config', () => {
    const config = loadFactoryConfig();
    expect(resolveSkipCI({ ...config, ci: { skip: false, comment: '' } }, { FACTORY_SKIP_CI: '1' })).toBe(true);
  });

  it('is false when FACTORY_SKIP_CI is exactly "0", even when config.ci.skip is true', () => {
    const config = loadFactoryConfig();
    expect(resolveSkipCI({ ...config, ci: { skip: true, comment: '' } }, { FACTORY_SKIP_CI: '0' })).toBe(false);
  });

  it('falls back to config.ci.skip when the env var is unset', () => {
    const config = loadFactoryConfig();
    expect(resolveSkipCI({ ...config, ci: { skip: true, comment: '' } }, {})).toBe(true);
    expect(resolveSkipCI({ ...config, ci: { skip: false, comment: '' } }, {})).toBe(false);
  });

  it('defaults to false when config.ci is absent', () => {
    const config = loadFactoryConfig();
    const { ci: _ci, ...withoutCi } = config;

    expect(resolveSkipCI(withoutCi as typeof config, {})).toBe(false);
  });
});

describe('resolveDefectWindowDays', () => {
  it('defaults to config.kpis.defectWindowDays (14) when the env var is unset', () => {
    const config = loadFactoryConfig();
    expect(resolveDefectWindowDays(config, {})).toBe(14);
  });

  it('is overridden by a positive FACTORY_DEFECT_WINDOW_DAYS', () => {
    const config = loadFactoryConfig();
    expect(resolveDefectWindowDays(config, { FACTORY_DEFECT_WINDOW_DAYS: '3' })).toBe(3);
  });

  it('falls back to the config value for "0", "-1", or non-numeric overrides', () => {
    const config = loadFactoryConfig();
    expect(resolveDefectWindowDays(config, { FACTORY_DEFECT_WINDOW_DAYS: '0' })).toBe(14);
    expect(resolveDefectWindowDays(config, { FACTORY_DEFECT_WINDOW_DAYS: '-1' })).toBe(14);
    expect(resolveDefectWindowDays(config, { FACTORY_DEFECT_WINDOW_DAYS: 'abc' })).toBe(14);
  });
});

describe('environment.ports config', () => {
  it('shipped config has default-enabled ports leasing over [3100, 3999]', () => {
    const config = loadFactoryConfig();
    expect(config.environment.ports).toEqual({
      enabled: true,
      range: [3100, 3999],
      comment: expect.any(String),
    });
  });

  it('applies environment.ports defaults when the config omits the key', async () => {
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
      expect(config.environment.ports.enabled).toBe(true);
      expect(config.environment.ports.range).toEqual([3100, 3999]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects an inverted port range', async () => {
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
        environment: { ports: { enabled: true, range: [3999, 3100] } },
      };
      await writeFile(path, JSON.stringify(minimal));
      expect(() => loadFactoryConfig(path)).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveEnvironmentPorts', () => {
  it('defaults to the shipped config values', () => {
    const config = loadFactoryConfig();
    expect(resolveEnvironmentPorts(config, {})).toEqual({ enabled: true, range: [3100, 3999] });
  });

  it('honors FACTORY_ENV_PORTS=0 to disable, overriding config', () => {
    const config = loadFactoryConfig();
    expect(
      resolveEnvironmentPorts(
        {
          ...config,
          environment: {
            ports: { enabled: true, range: [3100, 3999] },
            processGroups: { graceMs: 5000 },
            proxy: { enabled: false, port: 80, domain: 'factory.localhost' },
          },
        },
        { FACTORY_ENV_PORTS: '0' },
      ).enabled,
    ).toBe(false);
  });

  it('honors FACTORY_ENV_PORTS=1 to force-enable, overriding config', () => {
    const config = loadFactoryConfig();
    expect(
      resolveEnvironmentPorts(
        {
          ...config,
          environment: {
            ports: { enabled: false, range: [3100, 3999] },
            processGroups: { graceMs: 5000 },
            proxy: { enabled: false, port: 80, domain: 'factory.localhost' },
          },
        },
        { FACTORY_ENV_PORTS: '1' },
      ).enabled,
    ).toBe(true);
  });
});

describe('environment.proxy config', () => {
  it('shipped config has a disabled-by-default proxy on port 80 and factory.localhost', () => {
    const config = loadFactoryConfig();
    expect(config.environment.proxy).toEqual({
      enabled: false,
      port: 80,
      domain: 'factory.localhost',
      comment: expect.any(String),
    });
  });

  it('applies environment.proxy defaults when the config omits the key', async () => {
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
      expect(config.environment.proxy.enabled).toBe(false);
      expect(config.environment.proxy.port).toBe(80);
      expect(config.environment.proxy.domain).toBe('factory.localhost');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects an out-of-range port', async () => {
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
        environment: { proxy: { enabled: true, port: 70000, domain: 'factory.localhost' } },
      };
      await writeFile(path, JSON.stringify(minimal));
      expect(() => loadFactoryConfig(path)).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveEnvironmentProxy', () => {
  it('defaults to the shipped config values (disabled, port 80, factory.localhost)', () => {
    const config = loadFactoryConfig();
    expect(resolveEnvironmentProxy(config, {})).toEqual({
      enabled: false,
      port: 80,
      domain: 'factory.localhost',
    });
  });

  it('honors FACTORY_PROXY=1 to force-enable, overriding config', () => {
    const config = loadFactoryConfig();
    expect(resolveEnvironmentProxy(config, { FACTORY_PROXY: '1' }).enabled).toBe(true);
  });

  it('honors FACTORY_PROXY=0 to force-disable, overriding config', () => {
    const config = loadFactoryConfig();
    expect(
      resolveEnvironmentProxy(
        {
          ...config,
          environment: {
            ports: { enabled: true, range: [3100, 3999] },
            processGroups: { graceMs: 5000 },
            proxy: { enabled: true, port: 80, domain: 'factory.localhost' },
          },
        },
        { FACTORY_PROXY: '0' },
      ).enabled,
    ).toBe(false);
  });
});

describe('processGroups config', () => {
  it('defaults graceMs to 5000 when environment is omitted from factory.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'factory-config-test-'));
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
      expect(config.environment?.processGroups?.graceMs).toBe(5000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('parses an overridden graceMs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'factory-config-test-'));
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
        environment: { processGroups: { graceMs: 9000 } },
      };
      await writeFile(path, JSON.stringify(minimal));
      const config = loadFactoryConfig(path);
      expect(config.environment?.processGroups?.graceMs).toBe(9000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveProcessGroupGraceMs', () => {
  it('defaults to 5000 from the shipped config', () => {
    const config = loadFactoryConfig();
    expect(resolveProcessGroupGraceMs(config)).toBe(5000);
  });

  it('honors a configured override', () => {
    const config = loadFactoryConfig();
    expect(
      resolveProcessGroupGraceMs({
        ...config,
        environment: {
          ports: { enabled: true, range: [3100, 3999] },
          processGroups: { graceMs: 12000 },
          proxy: { enabled: false, port: 80, domain: 'factory.localhost' },
        },
      }),
    ).toBe(12000);
  });

  it('falls back to 5000 when environment is entirely absent', () => {
    const config = loadFactoryConfig();
    const { environment: _environment, ...rest } = config;
    expect(resolveProcessGroupGraceMs(rest as typeof config)).toBe(5000);
  });
});

describe('resolvePlanApproval', () => {
  let prevApprovePlan: string | undefined;

  beforeEach(() => {
    prevApprovePlan = process.env.FACTORY_APPROVE_PLAN;
    delete process.env.FACTORY_APPROVE_PLAN;
  });

  afterEach(() => {
    if (prevApprovePlan === undefined) delete process.env.FACTORY_APPROVE_PLAN;
    else process.env.FACTORY_APPROVE_PLAN = prevApprovePlan;
  });

  it('defaults to false from the shipped config', () => {
    const config = loadFactoryConfig();
    expect(resolvePlanApproval(config, {})).toBe(false);
  });

  it('is true when FACTORY_APPROVE_PLAN is exactly "1", regardless of config', () => {
    const config = loadFactoryConfig();
    expect(resolvePlanApproval({ ...config, plan_approval: { enabled: false } }, { FACTORY_APPROVE_PLAN: '1' })).toBe(
      true,
    );
  });

  it('is false when FACTORY_APPROVE_PLAN is exactly "0", even when config.plan_approval.enabled is true', () => {
    const config = loadFactoryConfig();
    expect(resolvePlanApproval({ ...config, plan_approval: { enabled: true } }, { FACTORY_APPROVE_PLAN: '0' })).toBe(
      false,
    );
  });

  it('falls back to config.plan_approval.enabled when the env var is unset', () => {
    const config = loadFactoryConfig();
    expect(resolvePlanApproval({ ...config, plan_approval: { enabled: true } }, {})).toBe(true);
  });
});

describe('resolveIngestConfig', () => {
  it('defaults to disabled from the shipped config', () => {
    const config = loadFactoryConfig();
    expect(resolveIngestConfig(config, {})).toEqual({ enabled: false, label: 'ready', lane: 'auto', maxPerCycle: 20 });
  });

  it('honors an enabled config value', () => {
    const config = loadFactoryConfig();
    const settings = resolveIngestConfig(
      { ...config, ingest: { enabled: true, label: 'triaged', lane: 'nightly', maxPerCycle: 3 } },
      {},
    );
    expect(settings).toEqual({ enabled: true, label: 'triaged', lane: 'nightly', maxPerCycle: 3 });
  });

  it('is true when FACTORY_AUTO_INGEST is exactly "1", regardless of config', () => {
    const config = loadFactoryConfig();
    expect(
      resolveIngestConfig({ ...config, ingest: { ...config.ingest, enabled: false } }, { FACTORY_AUTO_INGEST: '1' })
        .enabled,
    ).toBe(true);
  });

  it('is false when FACTORY_AUTO_INGEST is exactly "0", even when config.ingest.enabled is true', () => {
    const config = loadFactoryConfig();
    expect(
      resolveIngestConfig({ ...config, ingest: { ...config.ingest, enabled: true } }, { FACTORY_AUTO_INGEST: '0' })
        .enabled,
    ).toBe(false);
  });

  it('passes through label/lane/maxPerCycle from config unchanged', () => {
    const config = loadFactoryConfig();
    const settings = resolveIngestConfig(
      { ...config, ingest: { enabled: false, label: 'custom-label', lane: 'custom-lane', maxPerCycle: 7 } },
      {},
    );
    expect(settings.label).toBe('custom-label');
    expect(settings.lane).toBe('custom-lane');
    expect(settings.maxPerCycle).toBe(7);
  });
});

describe('resolveAutoFailover', () => {
  it('defaults to enabled, 30m cooldown, claude-sonnet-5 fallback from the shipped config', () => {
    const config = loadFactoryConfig();
    expect(resolveAutoFailover(config, {})).toEqual({
      enabled: true,
      cooldownMs: 1_800_000,
      fallbackModel: 'claude-sonnet-5',
    });
  });

  it('is false when FACTORY_AUTO_FAILOVER is exactly "0", even when config.auto_failover.enabled is true', () => {
    const config = loadFactoryConfig();
    expect(
      resolveAutoFailover(
        { ...config, auto_failover: { ...config.auto_failover, enabled: true } },
        {
          FACTORY_AUTO_FAILOVER: '0',
        },
      ).enabled,
    ).toBe(false);
  });

  it('is true when FACTORY_AUTO_FAILOVER is exactly "1", regardless of a disabled config', () => {
    const config = loadFactoryConfig();
    expect(
      resolveAutoFailover(
        { ...config, auto_failover: { ...config.auto_failover, enabled: false } },
        {
          FACTORY_AUTO_FAILOVER: '1',
        },
      ).enabled,
    ).toBe(true);
  });

  it('honors FACTORY_FAILOVER_COOLDOWN_MINUTES', () => {
    const config = loadFactoryConfig();
    expect(resolveAutoFailover(config, { FACTORY_FAILOVER_COOLDOWN_MINUTES: '5' }).cooldownMs).toBe(300_000);
  });

  it('falls back to config cooldown on a non-numeric or negative env override', () => {
    const config = loadFactoryConfig();
    expect(resolveAutoFailover(config, { FACTORY_FAILOVER_COOLDOWN_MINUTES: 'nope' }).cooldownMs).toBe(1_800_000);
    expect(resolveAutoFailover(config, { FACTORY_FAILOVER_COOLDOWN_MINUTES: '-5' }).cooldownMs).toBe(1_800_000);
  });

  it('lets FACTORY_FAILOVER_MODEL win over the config fallback', () => {
    const config = loadFactoryConfig();
    expect(resolveAutoFailover(config, { FACTORY_FAILOVER_MODEL: 'gpt-5.1' }).fallbackModel).toBe('gpt-5.1');
  });
});

describe('resolveLocalOnly', () => {
  it('is true when FACTORY_LOCAL_ONLY is exactly "1"', () => {
    expect(resolveLocalOnly({ FACTORY_LOCAL_ONLY: '1' })).toBe(true);
  });

  it('is false when FACTORY_LOCAL_ONLY is exactly "0"', () => {
    expect(resolveLocalOnly({ FACTORY_LOCAL_ONLY: '0' })).toBe(false);
  });

  it('is false when FACTORY_LOCAL_ONLY is unset or any other value', () => {
    expect(resolveLocalOnly({})).toBe(false);
    expect(resolveLocalOnly({ FACTORY_LOCAL_ONLY: 'true' })).toBe(false);
    expect(resolveLocalOnly({ FACTORY_LOCAL_ONLY: '' })).toBe(false);
  });
});

describe('resolveExperimental', () => {
  it('is true when FACTORY_EXPERIMENTAL is exactly "1"', () => {
    expect(resolveExperimental({ FACTORY_EXPERIMENTAL: '1' })).toBe(true);
  });

  it('is false when FACTORY_EXPERIMENTAL is exactly "0"', () => {
    expect(resolveExperimental({ FACTORY_EXPERIMENTAL: '0' })).toBe(false);
  });

  it('is false when FACTORY_EXPERIMENTAL is unset or any other value', () => {
    expect(resolveExperimental({})).toBe(false);
    expect(resolveExperimental({ FACTORY_EXPERIMENTAL: 'yes' })).toBe(false);
    expect(resolveExperimental({ FACTORY_EXPERIMENTAL: '' })).toBe(false);
  });
});

describe('resolveBranchPrefix', () => {
  it('uses a custom FACTORY_BRANCH_PREFIX', () => {
    expect(resolveBranchPrefix({ FACTORY_BRANCH_PREFIX: 'compare-local' })).toBe('compare-local');
  });

  it('falls back to the ship-it default when unset or empty', () => {
    expect(resolveBranchPrefix({})).toBe('ship-it');
    expect(resolveBranchPrefix({ FACTORY_BRANCH_PREFIX: '' })).toBe('ship-it');
  });
});

describe('getConstitutionsDir', () => {
  it('resolves a path ending in the constitutions directory', () => {
    expect(getConstitutionsDir()).toMatch(/constitutions$/);
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

  it('falls back to the hard-coded defaults when config.timeouts fields are all absent', () => {
    const config = loadFactoryConfig();
    const emptyTimeouts = { ...config, timeouts: {} as typeof config.timeouts };

    expect(resolveTimeouts(emptyTimeouts, {})).toEqual({ plan: 1800, build: 7200, check: 1800, approval: 1800 });
  });

  it('reads from process.env when no env argument is passed', () => {
    const config = loadFactoryConfig();
    const prev = process.env.FACTORY_PLAN_TIMEOUT;
    process.env.FACTORY_PLAN_TIMEOUT = '111';
    try {
      expect(resolveTimeouts(config).plan).toBe(111);
    } finally {
      if (prev === undefined) delete process.env.FACTORY_PLAN_TIMEOUT;
      else process.env.FACTORY_PLAN_TIMEOUT = prev;
    }
  });
});
