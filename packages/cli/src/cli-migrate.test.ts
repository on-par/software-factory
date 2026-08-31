import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyRepoConfig,
  getConstitutionsDir,
  getFactoryPaths,
  loadModelsConfig,
  loadRepoConfig,
  ModelRegistry,
  resolveCodexDisabled,
  resolveEffectiveModelPins,
  resolveEfficiencyPolicy,
  resolveUsageCap,
} from '@on-par/factory-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runMigrate } from './cli/index.js';

const tempDirs = new Set<string>();

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function tempRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'factory-migrate-test-'));
  tempDirs.add(repoRoot);
  return repoRoot;
}

function writeV1Fixture(repoRoot: string): void {
  const root = join(repoRoot, '.factory');
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      models: { plan: 'claude-opus-5', build: 'gpt-5.6-sol' },
      usage: { capUsd: 50 },
      efficiency: { fastPath: true, maxReworkRounds: 2, perIssueCapUsd: 8 },
    }),
  );
}

function effective(repoRoot: string) {
  const repo = loadRepoConfig(repoRoot);
  const models = loadModelsConfig();
  return {
    pins: resolveEffectiveModelPins(new ModelRegistry(models), repo, {}),
    usage: resolveUsageCap(repo, {}),
    efficiency: resolveEfficiencyPolicy(repo),
    codexDisabled: resolveCodexDisabled(repo, {}),
    applied: applyRepoConfig(models, repo),
  };
}

describe('runMigrate', () => {
  it('rewrites config, moves runtime state, and writes committed factory inputs', async () => {
    const repoRoot = tempRepo();
    const root = join(repoRoot, '.factory');
    writeV1Fixture(repoRoot);
    writeFileSync(join(root, 'events.ndjson'), 'event\n');
    writeFileSync(join(root, 'queue'), 'main 723\n');

    await runMigrate(repoRoot);

    const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf-8'));
    expect(config).toMatchObject({
      version: 2,
      models: { pins: { plan: 'claude-opus-5', build: 'gpt-5.6-sol' } },
      policy: { mode: 'pinned' },
      budget: { capUsd: 50, fastPath: true, maxReworkRounds: 2, perIssueCapUsd: 8 },
    });
    expect(config.$schema).toBeTypeOf('string');
    expect(existsSync(join(root, 'state', 'events.ndjson'))).toBe(true);
    expect(existsSync(join(root, 'state', 'queue'))).toBe(true);
    expect(existsSync(join(root, 'events.ndjson'))).toBe(false);
    expect(existsSync(join(root, 'queue'))).toBe(false);
    expect(readFileSync(join(root, '.gitignore'), 'utf-8')).toBe('state/\n');
    expect(existsSync(join(root, 'constitution.md'))).toBe(true);
  });

  it('round-trips effective config without a post-migration deprecation warning', async () => {
    const repoRoot = tempRepo();
    writeV1Fixture(repoRoot);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const before = effective(repoRoot);
    expect(warn).toHaveBeenCalledOnce();

    await runMigrate(repoRoot);
    warn.mockClear();

    expect(effective(repoRoot)).toEqual(before);
    expect(warn).not.toHaveBeenCalled();
  });

  it('is idempotent and dry-run writes nothing', async () => {
    const repoRoot = tempRepo();
    const root = join(repoRoot, '.factory');
    writeV1Fixture(repoRoot);
    await runMigrate(repoRoot);
    const paths = getFactoryPaths(repoRoot);
    const snapshot = [paths.config, paths.state, join(root, 'constitution.md'), join(root, '.gitignore')].map(
      (path) => ({
        path,
        content: existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf-8') : undefined,
        mtime: statSync(path).mtimeMs,
      }),
    );

    await runMigrate(repoRoot);
    expect(
      snapshot.map(({ path }) => ({
        path,
        content: statSync(path).isFile() ? readFileSync(path, 'utf-8') : undefined,
        mtime: statSync(path).mtimeMs,
      })),
    ).toEqual(snapshot);

    const dryRunRoot = tempRepo();
    writeV1Fixture(dryRunRoot);
    const dryConfig = readFileSync(join(dryRunRoot, '.factory', 'config.json'), 'utf-8');
    await runMigrate(dryRunRoot, { dryRun: true });
    expect(readFileSync(join(dryRunRoot, '.factory', 'config.json'), 'utf-8')).toBe(dryConfig);
    expect(existsSync(join(dryRunRoot, '.factory', 'state'))).toBe(false);
    expect(existsSync(join(dryRunRoot, '.factory', 'constitution.md'))).toBe(false);
    expect(existsSync(join(dryRunRoot, '.factory', '.gitignore'))).toBe(false);
  });

  it('uses the active bundled product constitution after moving the legacy product file', async () => {
    const repoRoot = tempRepo();
    const root = join(repoRoot, '.factory');
    const product = 'example-data-app';
    writeV1Fixture(repoRoot);
    writeFileSync(join(root, 'product'), `${product}\n`);

    await runMigrate(repoRoot);

    expect(readFileSync(join(root, 'state', 'product'), 'utf-8')).toBe(`${product}\n`);
    expect(existsSync(join(root, 'product'))).toBe(false);
    expect(readFileSync(join(root, 'constitution.md'), 'utf-8')).toBe(
      readFileSync(join(getConstitutionsDir(), `${product}.md`), 'utf-8'),
    );
  });
});
