import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { factoryConfigV2JsonSchema, loadConfigV2, loadRepoConfigV2, parseConfigV2 } from './v2.js';

let root: string;

function writeRepoConfig(content: unknown): void {
  mkdirSync(join(root, '.factory'), { recursive: true });
  writeFileSync(join(root, '.factory', 'config.json'), JSON.stringify(content));
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function freshRoot(): void {
  root = mkdtempSync(join(tmpdir(), 'factory-v2-'));
}

describe('loadRepoConfigV2', () => {
  it('returns null when the file does not exist', () => {
    freshRoot();
    expect(loadRepoConfigV2(root)).toBeNull();
  });

  it('a minimal overlay ({"version": 2}) is complete with defaults', () => {
    freshRoot();
    writeRepoConfig({ version: 2 });
    const config = loadRepoConfigV2(root);
    expect(config).not.toBeNull();
    expect(config?.run.timeouts.buildSeconds).toBe(7200);
    expect(config?.run.worktree.prefix).toBe('ship-it/');
    expect(config?.run.failover.fallbackModel).toBe('claude-sonnet-5');
    expect(config?.budget.usageCapUsd).toBe(227);
    expect(config?.budget.efficiency.maxReworkRounds).toBe(1);
    expect(config?.intake.ingest.enabled).toBe(false);
    expect(config?.intake.discovery.schedule).toBe('weekly');
    expect(config?.intake.filing.selfFixLabel).toBe('no-auto-merge');
    expect(config?.constitution.path).toBe('constitutions/');
    expect(config?.notifications.onShip).toBe(true);
    expect(config?.models.registry).toEqual({});
    expect(config?.routes).toEqual({});
    expect(config?.models.pins).toEqual({});
  });

  it('a sparse overlay keeps sibling defaults', () => {
    freshRoot();
    writeRepoConfig({
      version: 2,
      models: { pins: { build: 'gpt-5.6-sol' } },
      run: { timeouts: { buildSeconds: 3600 } },
      notifications: { onPark: false },
    });
    const config = loadRepoConfigV2(root);
    expect(config?.models.pins.build).toBe('gpt-5.6-sol');
    expect(config?.run.timeouts.buildSeconds).toBe(3600);
    expect(config?.notifications.onPark).toBe(false);
    expect(config?.run.timeouts.planSeconds).toBe(1800);
    expect(config?.notifications.onShip).toBe(true);
    expect(config?.models.providers).toEqual({});
  });

  it('parses and round-trips a full v2 config exercising every section', () => {
    freshRoot();
    const full = {
      version: 2,
      models: {
        registry: {
          m1: {
            provider: 'anthropic',
            tier: 'boss',
            costPerMtokInput: 3,
            costPerMtokOutput: 15,
            contextWindow: 200000,
            harness: 'claude-cli',
          },
        },
        tiers: { boss: ['m1'] },
        pins: {
          plan: 'm1',
          planFallback: 'm1',
          build: 'm1',
          buildFallback: 'm1',
          checker: 'm1',
          triage: 'm1',
        },
        providers: { anthropic: true, openai: false, ollama: true },
        failover: {
          triggers: ['rate_limit'],
          maxRetries: 5,
          cooldownMs: 1000,
          escalateAfterTierExhausted: false,
        },
      },
      routes: {
        plan: { tier: 'boss' },
        build: { tier: 'worker', requires: 'agentic' },
      },
      run: {
        timeouts: {
          planSeconds: 100,
          buildSeconds: 200,
          checkSeconds: 300,
          mergePollSeconds: 400,
          approvalSeconds: 500,
        },
        merge: { auto: true },
        worktree: { prefix: 'wt/', parent: '/tmp/', gcTtlDays: 3, autoGcOnRun: false },
        ci: { skip: true },
        planApproval: { enabled: true },
        sandbox: {
          enabled: false,
          network: { allow: ['example.com'] },
          resources: { cpuMs: 1000, memMb: 512 },
        },
        environment: {
          ports: { enabled: false, range: [4000, 4100] },
          processGroups: { graceMs: 1000 },
          proxy: { enabled: true, port: 8080, domain: 'example.localhost' },
        },
        failover: { enabled: false, cooldownMinutes: 10, fallbackModel: 'm1' },
        kpis: { defectWindowDays: 7 },
      },
      budget: {
        usageCapUsd: 500,
        perIssueCapUsd: 10,
        costTracking: { enabled: false, logFile: 'costs.jsonl' },
        efficiency: { fastPath: true, maxReworkRounds: 3 },
      },
      intake: {
        ingest: { enabled: true, label: 'go', lane: 'manual', maxPerCycle: 5 },
        discovery: { enabled: false, schedule: 'daily', maxCandidates: 10 },
        filing: {
          enabled: false,
          excludeReasons: ['timeout'],
          repeatThreshold: 1,
          maxPerRun: 1,
          maxPerDay: 1,
          selfFixLabel: 'self-fix',
          bugLabels: ['defect'],
          sensitivePaths: ['src/'],
        },
      },
      constitution: { path: 'docs/constitutions/' },
      notifications: { onShip: false, onFail: false, onEscalate: false, onPark: false, onMerge: false },
    };
    writeRepoConfig(full);
    const config = loadRepoConfigV2(root);
    expect(config?.models.registry.m1?.harness).toBe('claude-cli');
    expect(config?.models.tiers).toEqual({ boss: ['m1'] });
    expect(config?.models.pins).toEqual(full.models.pins);
    expect(config?.models.providers).toEqual(full.models.providers);
    expect(config?.models.failover).toEqual(full.models.failover);
    expect(config?.routes.build).toEqual({ tier: 'worker', requires: 'agentic' });
    expect(config?.run.timeouts).toEqual(full.run.timeouts);
    expect(config?.run.merge).toEqual(full.run.merge);
    expect(config?.run.worktree).toEqual(full.run.worktree);
    expect(config?.run.ci).toEqual(full.run.ci);
    expect(config?.run.planApproval).toEqual(full.run.planApproval);
    expect(config?.run.sandbox).toEqual(full.run.sandbox);
    expect(config?.run.environment).toEqual(full.run.environment);
    expect(config?.run.failover).toEqual(full.run.failover);
    expect(config?.run.kpis).toEqual(full.run.kpis);
    expect(config?.budget).toEqual(full.budget);
    expect(config?.intake).toEqual(full.intake);
    expect(config?.constitution).toEqual(full.constitution);
    expect(config?.notifications).toEqual(full.notifications);
  });

  it('accepts a top-level $schema key', () => {
    freshRoot();
    writeRepoConfig({ $schema: 'https://example.com/factory.schema.json', version: 2 });
    expect(() => loadRepoConfigV2(root)).not.toThrow();
  });

  it('rejects an unknown top-level key, naming the path and key', () => {
    freshRoot();
    writeRepoConfig({ version: 2, modles: {} });
    expect(() => loadRepoConfigV2(root)).toThrow(/config\.json/);
    expect(() => loadRepoConfigV2(root)).toThrow(/modles/);
  });

  it('rejects an unknown nested key, naming the path and key', () => {
    freshRoot();
    writeRepoConfig({ version: 2, run: { timeouts: { plan_seconds: 1 } } });
    expect(() => loadRepoConfigV2(root)).toThrow(/config\.json/);
    expect(() => loadRepoConfigV2(root)).toThrow(/plan_seconds/);
  });

  it('returns null for a v1 file', () => {
    freshRoot();
    writeRepoConfig({ version: 1, models: { build: 'x' } });
    expect(loadRepoConfigV2(root)).toBeNull();
  });

  it('returns null for a file with no version field', () => {
    freshRoot();
    writeRepoConfig({});
    expect(loadRepoConfigV2(root)).toBeNull();
  });

  it('throws naming the path on malformed JSON', () => {
    freshRoot();
    mkdirSync(join(root, '.factory'), { recursive: true });
    writeFileSync(join(root, '.factory', 'config.json'), '{ not json');
    expect(() => loadRepoConfigV2(root)).toThrow(/config\.json/);
  });

  it('rejects an unknown harness in a registry entry, naming the path', () => {
    freshRoot();
    writeRepoConfig({
      version: 2,
      models: {
        registry: {
          m1: {
            provider: 'anthropic',
            tier: 'boss',
            costPerMtokInput: 1,
            costPerMtokOutput: 1,
            contextWindow: 1000,
            harness: 'nope',
          },
        },
      },
    });
    expect(() => loadRepoConfigV2(root)).toThrow(/models\.registry\.m1\.harness/);
    expect(() => loadRepoConfigV2(root)).toThrow(/known harnesses/);
  });
});

describe('loadConfigV2', () => {
  it('throws naming the path on a missing file', () => {
    freshRoot();
    const missing = join(root, 'does-not-exist.json');
    expect(() => loadConfigV2(missing)).toThrow(/does-not-exist\.json/);
  });

  it('reads and validates a v2 config at an explicit path', () => {
    freshRoot();
    const path = join(root, 'v2.json');
    writeFileSync(path, JSON.stringify({ version: 2 }));
    const config = loadConfigV2(path);
    expect(config.version).toBe(2);
  });
});

describe('parseConfigV2', () => {
  it('throws a path-qualified error on invalid input', () => {
    expect(() => parseConfigV2({ version: 1 }, 'somewhere.json')).toThrow(/somewhere\.json/);
  });
});

describe('factoryConfigV2JsonSchema', () => {
  it('emits a draft 2020-12 JSON Schema with descriptions and no comment fields', () => {
    const js = factoryConfigV2JsonSchema();
    expect(js.$schema).toMatch(/json-schema\.org/);
    const serialized = JSON.stringify(js);
    expect(serialized).toContain('usage cap');
    expect(serialized).not.toContain('"comment"');
    const properties = js.properties as Record<string, any>;
    expect(properties.version.const).toBe(2);
  });
});
