import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadFactoryConfig, loadFactoryConfigForRepo } from './index.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'factory-config-ceiling-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('build.contextCeiling (#3327)', () => {
  const load = async (cfg: unknown) => {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify(cfg));
    return loadFactoryConfigForRepo(path);
  };

  it('defaults to { codex-cli: 120000 }', () => {
    expect(loadFactoryConfig().build.contextCeiling).toEqual({ 'codex-cli': 120000 });
  });

  it('merges a repo override', async () => {
    const c = await load({ build: { contextCeiling: { 'codex-cli': 90000 } } });
    expect(c.build.contextCeiling).toEqual({ 'codex-cli': 90000 });
  });

  it('keeps the codex-cli default beside another harness key', async () => {
    const c = await load({ build: { contextCeiling: { 'claude-cli': 1 } } });
    expect(c.build.contextCeiling).toEqual({ 'codex-cli': 120000, 'claude-cli': 1 });
  });

  it('keeps the default when only publishFromBuild is set', async () => {
    const c = await load({ build: { publishFromBuild: true } });
    expect(c.build.contextCeiling).toEqual({ 'codex-cli': 120000 });
  });

  it('loads 0 (off)', async () => {
    const c = await load({ build: { contextCeiling: { 'codex-cli': 0 } } });
    expect(c.build.contextCeiling['codex-cli']).toBe(0);
  });

  it('rejects a negative build.contextCeiling with an error naming the key', async () => {
    await expect(load({ build: { contextCeiling: { 'codex-cli': -5 } } })).rejects.toThrow(/build\.contextCeiling/);
  });

  it('rejects a non-integer and a string', async () => {
    await expect(load({ build: { contextCeiling: { 'codex-cli': 1.5 } } })).rejects.toThrow(/build\.contextCeiling/);
    await expect(load({ build: { contextCeiling: { 'codex-cli': '90000' } } })).rejects.toThrow(
      /build\.contextCeiling/,
    );
  });
});
