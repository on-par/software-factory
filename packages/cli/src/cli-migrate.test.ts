import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyRepoConfig,
  getConstitutionsDir,
  getFactoryPaths,
  loadFactoryConfigForRepo,
  loadModelsConfig,
  loadRepoConfig,
  ModelRegistry,
  resolveCodexDisabled,
  resolveEffectiveModelPins,
  resolveEfficiencyPolicy,
  resolveUsageCap,
} from '@on-par/factory-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliExitError, runMigrate } from './cli/index.js';

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

function snapshotEntry(path: string): { path: string; content: string | undefined; mtime: number } {
  const fd = openSync(path, 'r');
  try {
    const mtime = fstatSync(fd).mtimeMs;
    let content: string | undefined;
    try {
      content = readFileSync(fd, 'utf-8');
    } catch (err: any) {
      if (err.code !== 'EISDIR') throw err;
    }
    return { path, content, mtime };
  } finally {
    closeSync(fd);
  }
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
  it('is a no-op when .factory/config.json does not exist', async () => {
    const repoRoot = tempRepo();
    mkdirSync(join(repoRoot, '.factory'), { recursive: true });

    await expect(runMigrate(repoRoot)).resolves.toBeUndefined();

    expect(existsSync(join(repoRoot, '.factory', 'config.json'))).toBe(false);
  });

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
    expect(config).not.toHaveProperty('$schema');
    expect(existsSync(join(root, 'state', 'events.ndjson'))).toBe(true);
    expect(existsSync(join(root, 'state', 'queue'))).toBe(true);
    expect(existsSync(join(root, 'events.ndjson'))).toBe(false);
    expect(existsSync(join(root, 'queue'))).toBe(false);
    expect(readFileSync(join(root, '.gitignore'), 'utf-8')).toBe('state/\n');
    expect(existsSync(join(root, 'constitution.md'))).toBe(true);
  });

  it('keeps runtime-policy keys and an existing $schema when rewriting a v1 config', async () => {
    const repoRoot = tempRepo();
    const root = join(repoRoot, '.factory');
    mkdirSync(root, { recursive: true });
    const runtime = {
      sweep: { heartbeatFile: '/tmp/heartbeat' },
      run: { merge: { auto: true } },
      timeouts: { build_seconds: 600 },
      workspace: { backend: 'disposable-docker' },
    };
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ $schema: './my-schema.json', version: 1, models: { plan: 'claude-opus-5' }, ...runtime }),
    );

    await runMigrate(repoRoot);

    const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf-8'));
    expect(config).toMatchObject({ $schema: './my-schema.json', version: 2, ...runtime });
    expect(loadFactoryConfigForRepo(join(root, 'config.json'))).toMatchObject(runtime);
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
      snapshotEntry,
    );

    await runMigrate(repoRoot);
    expect(snapshot.map(({ path }) => snapshotEntry(path))).toEqual(snapshot);

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

describe('runMigrate --to-yaml', () => {
  const setup = (): { repoRoot: string; root: string } => {
    const repoRoot = tempRepo();
    const root = join(repoRoot, '.factory');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 2, merge: { auto: true } }));
    return { repoRoot, root };
  };

  it('converts config.json to config.yaml with equal values and skips the layout steps', async () => {
    const { repoRoot, root } = setup();
    const before = loadFactoryConfigForRepo(join(root, 'config.json'));
    await runMigrate(repoRoot, { toYaml: true });
    expect(existsSync(join(root, 'config.json'))).toBe(false);
    expect(existsSync(join(root, 'config.yaml'))).toBe(true);
    expect(loadFactoryConfigForRepo(join(root, 'config.yaml'))).toEqual(before);
    expect(existsSync(join(root, 'constitution.md'))).toBe(false);
  });

  it('writes nothing on --dry-run', async () => {
    const { repoRoot, root } = setup();
    await runMigrate(repoRoot, { toYaml: true, dryRun: true });
    expect(existsSync(join(root, 'config.json'))).toBe(true);
    expect(existsSync(join(root, 'config.yaml'))).toBe(false);
  });

  it('is a no-op for a YAML repo and for no config', async () => {
    const { repoRoot, root } = setup();
    rmSync(join(root, 'config.json'));
    await expect(runMigrate(repoRoot, { toYaml: true })).resolves.toBeUndefined();
    writeFileSync(join(root, 'config.yaml'), 'version: 2\n');
    await expect(runMigrate(repoRoot, { toYaml: true })).resolves.toBeUndefined();
  });

  it('exits 1 when the round trip fails', async () => {
    const { repoRoot } = setup();
    const err = await runMigrate(repoRoot, {
      toYaml: true,
      migrateToYaml: () => ({ status: 'round-trip-failed', from: 'x', reason: 'x' }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliExitError);
    expect((err as CliExitError).code).toBe(1);
  });

  it('maps a core error (both files present) to exit 1', async () => {
    const { repoRoot, root } = setup();
    writeFileSync(join(root, 'config.yaml'), 'version: 2\n');
    const err = await runMigrate(repoRoot, { toYaml: true }).catch((e: unknown) => e);
    expect((err as CliExitError).code).toBe(1);
  });
});
