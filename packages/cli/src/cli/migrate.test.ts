// packages/cli/src/cli/migrate.test.ts — runMigrate against YAML and JSON repo configs (#3436)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadRepoConfig } from '@on-par/factory-core';
import { readRepoConfigFile } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliExitError, runMigrate } from './index.js';

const temp = createTempDirs();
let logs: string[];

beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await temp.cleanup();
});

function repoWith(files: Record<string, string>): { repoRoot: string; root: string } {
  const repoRoot = temp.makeSync('factory-migrate-yaml-');
  const root = join(repoRoot, '.factory');
  mkdirSync(root, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return { repoRoot, root };
}

const V1_YAML =
  '# my pins\nversion: 1\nmodels:\n  plan: claude-opus-5\n  build: gpt-5.6-sol\nusage:\n  capUsd: 50\nsweep:\n  loopIntervalSeconds: 300\n';

describe('runMigrate on a YAML config', () => {
  it("does not throw on '# comment\\nversion: 2\\n' and runs the constitution and .gitignore steps", async () => {
    const text = '# comment\nversion: 2\n';
    const { repoRoot, root } = repoWith({ 'config.yaml': text });

    await expect(runMigrate(repoRoot)).resolves.toBeUndefined();

    expect(existsSync(join(root, 'constitution.md'))).toBe(true);
    expect(existsSync(join(root, '.gitignore'))).toBe(true);
    expect(existsSync(join(root, 'state'))).toBe(true);
    expect(readFileSync(join(root, 'config.yaml'), 'utf-8')).toBe(text);
    expect(readRepoConfigFile(join(root, 'config.yaml'))).toEqual({ version: 2 });
    expect(logs).toContain('config.yaml already v2');
  });

  it('completes every step on a commented v2 config.yaml and leaves it unchanged', async () => {
    const text = '# top\nversion: 2\nmerge:\n  auto: false # keep manual\n';
    const { repoRoot, root } = repoWith({ 'config.yaml': text, 'events.ndjson': 'e\n' });

    await runMigrate(repoRoot);

    expect(readFileSync(join(root, 'config.yaml'), 'utf-8')).toBe(text);
    expect(existsSync(join(root, 'state', 'events.ndjson'))).toBe(true);
    expect(existsSync(join(root, 'constitution.md'))).toBe(true);
    expect(existsSync(join(root, '.gitignore'))).toBe(true);
  });

  it('rewrites a v1 config.yaml to v2 in place, keeping comments and runtime keys', async () => {
    const { repoRoot, root } = repoWith({ 'config.yaml': V1_YAML });
    const before = loadRepoConfig(repoRoot);

    await runMigrate(repoRoot);

    const text = readFileSync(join(root, 'config.yaml'), 'utf-8');
    expect(text).toContain('# my pins');
    const parsed = readRepoConfigFile(join(root, 'config.yaml')) as Record<string, unknown>;
    expect(parsed.version).toBe(2);
    expect(parsed.sweep).toEqual({ loopIntervalSeconds: 300 });
    expect(parsed).not.toHaveProperty('usage');
    expect(loadRepoConfig(repoRoot)).toMatchObject({ models: { pins: before?.models?.pins }, budget: { capUsd: 50 } });
    expect(existsSync(join(root, 'config.json'))).toBe(false);
    expect(logs).toContain('rewrote .factory/config.yaml to v2');
  });

  it('rejects with both files named and moves no state when config.yaml and config.json both exist', async () => {
    const { repoRoot, root } = repoWith({
      'config.yaml': 'version: 2\n',
      'config.json': '{"version":2}',
      'events.ndjson': 'e\n',
    });

    const err = await runMigrate(repoRoot).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CliExitError);
    expect((err as Error).message).toContain('config.yaml');
    expect((err as Error).message).toContain('config.json');
    expect(existsSync(join(root, 'events.ndjson'))).toBe(true);
    expect(existsSync(join(root, 'state', 'events.ndjson'))).toBe(false);
  });

  it('leaves a v1 config.yaml unchanged on dryRun', async () => {
    const { repoRoot, root } = repoWith({ 'config.yaml': V1_YAML });

    await runMigrate(repoRoot, { dryRun: true });

    expect(readFileSync(join(root, 'config.yaml'), 'utf-8')).toBe(V1_YAML);
    expect(logs).toContain('would rewrite .factory/config.yaml to v2');
  });
});

describe('runMigrate on a JSON config', () => {
  it('rewrites a v1 config.json to the same v2 JSON text as before', async () => {
    const { repoRoot, root } = repoWith({
      'config.json': JSON.stringify({
        version: 1,
        models: { plan: 'claude-opus-5' },
        sweep: { loopIntervalSeconds: 300 },
      }),
    });
    const expected = {
      version: 2,
      ...(loadRepoConfig(repoRoot) as Record<string, unknown>),
      sweep: { loopIntervalSeconds: 300 },
    };
    delete (expected as Record<string, unknown>).$schema;
    expected.version = 2;

    await runMigrate(repoRoot);

    const text = readFileSync(join(root, 'config.json'), 'utf-8');
    const { version: _v, ...rest } = expected;
    expect(text).toBe(`${JSON.stringify({ version: 2, ...rest }, null, 2)}\n`);
    expect(logs).toContain('rewrote .factory/config.json to v2');
  });

  it('leaves a v2 config.json untouched and says so', async () => {
    const text = '{"version":2}';
    const { repoRoot, root } = repoWith({ 'config.json': text });

    await runMigrate(repoRoot);

    expect(readFileSync(join(root, 'config.json'), 'utf-8')).toBe(text);
    expect(logs).toContain('config.json already v2');
  });
});
