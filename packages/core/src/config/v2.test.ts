import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FactoryConfigV2Schema,
  factoryConfigV2JsonSchema,
  loadV2Config,
  parseV2Config,
  type FactoryConfigV2,
} from './v2.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'factory-v2-config-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(contents: unknown): Promise<string> {
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify(contents));
  return path;
}

describe('zero-config: { version: 2 }', () => {
  it('validates and fills every section with defaults', () => {
    const cfg = parseV2Config({ version: 2 });

    expect(cfg.version).toBe(2);

    // models
    expect(cfg.models.registry).toEqual({});
    expect(cfg.models.tiers).toEqual({});
    expect(cfg.models.pins).toEqual({});
    expect(cfg.models.providers).toEqual({});
    expect(cfg.models.failover).toEqual({
      triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
      maxRetries: 2,
      cooldownMs: 5000,
      escalateAfterTierExhausted: true,
    });
    expect(cfg.models.routingRules).toEqual({});

    // routes
    expect(cfg.routes).toEqual({});

    // run — nested defaults must be filled (prefault, not default)
    expect(cfg.run.merge).toEqual({ auto: false, admin: false });
    expect(cfg.run.timeouts).toEqual({
      plan_seconds: 1800,
      build_seconds: 7200,
      check_seconds: 1800,
      merge_poll_seconds: 120,
      approval_seconds: 1800,
    });
    expect(cfg.run.sandbox).toEqual({
      enabled: true,
      network: { allow: ['api.anthropic.com', 'github.com'] },
      resources: { cpuMs: 300_000, memMb: 4096 },
    });
    expect(cfg.run.worktree).toEqual({
      prefix: 'ship-it/',
      parent: '../',
      gcTtlDays: 7,
      autoGcOnRun: true,
    });
    expect(cfg.run.environment.ports).toEqual({ enabled: true, range: [3100, 3999] });
    expect(cfg.run.environment.processGroups).toEqual({ graceMs: 5000 });
    expect(cfg.run.environment.proxy).toEqual({ enabled: false, port: 80, domain: 'factory.localhost' });
    expect(cfg.run.autoFailover).toEqual({ enabled: true, cooldownMinutes: 30, fallbackModel: 'claude-sonnet-5' });
    expect(cfg.run.efficiency).toEqual({ fastPath: false, maxReworkRounds: 1 });
    expect(cfg.run.ci).toEqual({ skip: false });
    expect(cfg.run.planApproval).toEqual({ enabled: false });
    expect(cfg.run.branchPrefix).toBe('ship-it');
    expect(cfg.run.byok).toEqual({ enabled: false });

    // budget
    expect(cfg.budget.usageCapUsd).toBe(227);
    expect(cfg.budget.costTracking).toEqual({ enabled: true, logFile: '.factory/costs.jsonl' });
    expect(cfg.budget.kpis).toEqual({ defectWindowDays: 14 });

    // intake
    expect(cfg.intake.ingest).toEqual({ enabled: false, label: 'ready', lane: 'auto', maxPerCycle: 20 });
    expect(cfg.intake.discovery).toEqual({ enabled: true, schedule: 'weekly', maxCandidates: 5 });
    expect(cfg.intake.filing.enabled).toBe(true);
    expect(cfg.intake.filing.sensitivePaths).toContain('packages/core/');

    // constitution + notifications
    expect(cfg.constitution).toEqual({ path: 'constitutions/' });
    expect(cfg.notifications).toEqual({
      on_ship: true,
      on_fail: true,
      on_escalate: true,
      on_park: true,
      on_merge: true,
    });
  });

  it('loads a { version: 2 } file from disk with all defaults', async () => {
    const path = await writeConfig({ version: 2 });
    const cfg = loadV2Config(path);
    expect(cfg.run.timeouts.build_seconds).toBe(7200);
    expect(cfg.budget.usageCapUsd).toBe(227);
  });
});

describe('sparse overlay', () => {
  it('applies a partial override while defaulting siblings', () => {
    const cfg = parseV2Config({
      version: 2,
      run: { merge: { auto: true }, timeouts: { build_seconds: 3600 } },
      budget: { usageCapUsd: 50 },
    });

    // overridden
    expect(cfg.run.merge.auto).toBe(true);
    expect(cfg.run.timeouts.build_seconds).toBe(3600);
    expect(cfg.budget.usageCapUsd).toBe(50);

    // sibling fields inside a partially-specified object still default
    expect(cfg.run.merge.admin).toBe(false);
    expect(cfg.run.timeouts.plan_seconds).toBe(1800);

    // untouched sibling sections still fully default
    expect(cfg.run.sandbox.enabled).toBe(true);
    expect(cfg.budget.costTracking.enabled).toBe(true);
    expect(cfg.intake.discovery.schedule).toBe('weekly');
  });

  it('accepts a per-repo model pin + tier + provider overlay', () => {
    const cfg = parseV2Config({
      version: 2,
      models: {
        pins: { plan: 'claude-opus-5', build: 'gpt-5.6-terra-medium' },
        tiers: { worker: ['gpt-5.6-terra-medium', 'claude-sonnet-5'] },
        providers: { ollama: false },
      },
    });
    expect(cfg.models.pins.plan).toBe('claude-opus-5');
    expect(cfg.models.tiers.worker).toEqual(['gpt-5.6-terra-medium', 'claude-sonnet-5']);
    expect(cfg.models.providers.ollama).toBe(false);
    // failover still defaults even though a sibling of models was set
    expect(cfg.models.failover.maxRetries).toBe(2);
  });

  it('loads a sparse overlay file from disk', async () => {
    const path = await writeConfig({ version: 2, run: { branchPrefix: 'exp' } });
    const cfg = loadV2Config(path);
    expect(cfg.run.branchPrefix).toBe('exp');
    expect(cfg.run.merge.auto).toBe(false);
  });
});

describe('full v2 config', () => {
  const full: FactoryConfigV2 = {
    version: 2,
    models: {
      registry: {
        'claude-opus-5': {
          provider: 'anthropic',
          tier: 'boss',
          costPerMtokInput: 5,
          costPerMtokOutput: 25,
          contextWindow: 200000,
          capabilities: ['planning', 'review'],
          envKey: null,
          harness: 'claude-cli',
          claudeFlag: 'claude-opus-5',
        },
        'gpt-5.6-terra-medium': {
          provider: 'openai',
          tier: ['worker'],
          costPerMtokInput: 1.25,
          costPerMtokOutput: 10,
          contextWindow: 272000,
          capabilities: ['implementation', 'codex'],
          envKey: null,
          harness: 'codex-cli',
          codex: true,
          codexFlag: '-m gpt-5.6-terra -c model_reasoning_effort=medium',
        },
      },
      tiers: { boss: ['claude-opus-5'], worker: ['gpt-5.6-terra-medium'] },
      pins: { plan: 'claude-opus-5', build: 'gpt-5.6-terra-medium' },
      providers: { anthropic: true, openai: true, ollama: false },
      failover: {
        triggers: ['rate_limit', 'usage_cap'],
        maxRetries: 3,
        cooldownMs: 1000,
        escalateAfterTierExhausted: false,
      },
      routingRules: { codex_available: { if: 'command -v codex' } },
    },
    routes: {
      plan: { tier: 'boss', description: 'Spec writing' },
      build_codex: { tier: 'worker', description: 'Codex build', requires: 'codex' },
    },
    run: {
      merge: { auto: true, admin: true },
      timeouts: {
        plan_seconds: 900,
        build_seconds: 3600,
        check_seconds: 900,
        merge_poll_seconds: 60,
        approval_seconds: 600,
      },
      sandbox: { enabled: false, network: { allow: [] }, resources: { cpuMs: 100, memMb: 512 } },
      worktree: { prefix: 'wt/', parent: '../wt', gcTtlDays: 3, autoGcOnRun: false },
      environment: {
        ports: { enabled: false, range: [4000, 4100] },
        processGroups: { graceMs: 1000 },
        proxy: { enabled: true, port: 8080, domain: 'lane.test' },
      },
      autoFailover: { enabled: false, cooldownMinutes: 5, fallbackModel: 'claude-sonnet-5' },
      efficiency: { fastPath: true, maxReworkRounds: 0, perIssueCapUsd: 10 },
      ci: { skip: true },
      planApproval: { enabled: true },
      branchPrefix: 'factory',
      byok: { enabled: true },
    },
    budget: {
      usageCapUsd: 500,
      costTracking: { enabled: false, logFile: 'costs.jsonl' },
      kpis: { defectWindowDays: 30 },
    },
    intake: {
      ingest: { enabled: true, label: 'go', lane: 'main', maxPerCycle: 5 },
      discovery: { enabled: false, schedule: 'daily', maxCandidates: 3 },
      filing: {
        enabled: false,
        excludeReasons: ['timeout'],
        repeatThreshold: 2,
        maxPerRun: 1,
        maxPerDay: 2,
        selfFixLabel: 'blocked',
        bugLabels: ['defect'],
        sensitivePaths: ['src/'],
      },
    },
    constitution: { path: 'docs/constitution.md' },
    notifications: { on_ship: false, on_fail: true },
  };

  it('round-trips a fully-specified config unchanged', () => {
    const cfg = parseV2Config(full);
    expect(cfg).toEqual(full);
  });

  it('loads a fully-specified config from disk', async () => {
    const path = await writeConfig(full);
    const cfg = loadV2Config(path);
    expect(cfg.models.registry['gpt-5.6-terra-medium'].codex).toBe(true);
    expect(cfg.run.environment.proxy.domain).toBe('lane.test');
    expect(cfg.intake.filing.selfFixLabel).toBe('blocked');
  });
});

describe('validation errors', () => {
  it('rejects a wrong version', () => {
    expect(() => parseV2Config({ version: 1 })).toThrow(/version/);
  });

  it('rejects an unknown provider', () => {
    expect(() =>
      parseV2Config({
        version: 2,
        models: {
          registry: {
            m: {
              provider: 'mystery',
              tier: 'boss',
              costPerMtokInput: 0,
              costPerMtokOutput: 0,
              contextWindow: 1,
              capabilities: [],
              envKey: null,
            },
          },
        },
      }),
    ).toThrow(/Invalid v2 config/);
  });

  it('rejects an inverted port range', () => {
    expect(() => parseV2Config({ version: 2, run: { environment: { ports: { range: [4000, 3000] } } } })).toThrow(
      /\[low, high\]/,
    );
  });

  it('names the file path when a file is malformed', async () => {
    const path = join(dir, 'config.json');
    await writeFile(path, '{ not json');
    expect(() => loadV2Config(path)).toThrow(new RegExp(`Failed to parse ${path.replace(/[.]/g, '\\.')}`));
  });

  it('names the file path on a schema violation', async () => {
    const path = await writeConfig({ version: 3 });
    expect(() => loadV2Config(path)).toThrow(new RegExp(`Invalid ${path.replace(/[.]/g, '\\.')}`));
  });
});

describe('JSON Schema generation', () => {
  it('emits draft 2020-12 with $schema and no "comment" pseudo-doc fields', () => {
    const schema = factoryConfigV2JsonSchema();
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');

    const serialized = JSON.stringify(schema);
    // Field docs live in `description`, never in a `comment` pseudo-field.
    expect(serialized).not.toContain('"comment"');
    expect(serialized).toContain('"description"');
  });

  it('carries field descriptions from .describe() onto properties', () => {
    const schema = factoryConfigV2JsonSchema() as any;
    expect(schema.properties.version.description).toMatch(/Config schema version/);
    // A deeply-nested field description survives generation.
    const buildSeconds = schema.properties.run.properties.timeouts.properties.build_seconds;
    expect(buildSeconds.description).toMatch(/BUILD phase timeout/);
  });
});

describe('exported schema shape', () => {
  it('exposes the top-level sections the issue enumerates', () => {
    const shape = FactoryConfigV2Schema.shape;
    expect(Object.keys(shape).sort()).toEqual(
      ['budget', 'constitution', 'intake', 'models', 'notifications', 'routes', 'run', 'version'].sort(),
    );
  });
});
