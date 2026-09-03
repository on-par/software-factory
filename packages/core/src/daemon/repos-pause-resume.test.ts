import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { emptyRegistry, loadRegistry, upsertRepo, writeRegistry } from './registry.js';
import { setRepoState } from './repos-pause-resume.js';

const tmpDirs: string[] = [];

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'repos-pause-resume-test-'));
  tmpDirs.push(dir);
  return join(dir, 'registry.json');
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('setRepoState', () => {
  it('pauses an attached active repo, preserving path and attachedAt', async () => {
    const registryFile = await tmpFile();
    const registry = upsertRepo(emptyRegistry(), 'on-par/software-factory', {
      path: '/repos/software-factory',
      attachedAt: '2026-08-19T12:00:00.000Z',
      state: 'active',
    });
    await writeRegistry(registryFile, registry);

    const result = await setRepoState(registryFile, 'on-par/software-factory', 'paused');

    expect(result).toEqual({
      ok: true,
      entry: {
        slug: 'on-par/software-factory',
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'paused',
      },
    });

    const loaded = await loadRegistry(registryFile);
    expect(loaded.repos['on-par/software-factory']).toEqual({
      path: '/repos/software-factory',
      attachedAt: '2026-08-19T12:00:00.000Z',
      state: 'paused',
    });
  });

  it('resumes a paused repo back to active', async () => {
    const registryFile = await tmpFile();
    const registry = upsertRepo(emptyRegistry(), 'on-par/software-factory', {
      path: '/repos/software-factory',
      attachedAt: '2026-08-19T12:00:00.000Z',
      state: 'paused',
    });
    await writeRegistry(registryFile, registry);

    const result = await setRepoState(registryFile, 'on-par/software-factory', 'active');

    expect(result).toEqual({
      ok: true,
      entry: {
        slug: 'on-par/software-factory',
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'active',
      },
    });
  });

  it('is idempotent: pausing an already-paused repo succeeds and leaves it paused', async () => {
    const registryFile = await tmpFile();
    const registry = upsertRepo(emptyRegistry(), 'on-par/software-factory', {
      path: '/repos/software-factory',
      attachedAt: '2026-08-19T12:00:00.000Z',
      state: 'paused',
    });
    await writeRegistry(registryFile, registry);

    const result = await setRepoState(registryFile, 'on-par/software-factory', 'paused');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.state).toBe('paused');
  });

  it('is idempotent: resuming an already-active repo succeeds and leaves it active', async () => {
    const registryFile = await tmpFile();
    const registry = upsertRepo(emptyRegistry(), 'on-par/software-factory', {
      path: '/repos/software-factory',
      attachedAt: '2026-08-19T12:00:00.000Z',
      state: 'active',
    });
    await writeRegistry(registryFile, registry);

    const result = await setRepoState(registryFile, 'on-par/software-factory', 'active');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.state).toBe('active');
  });

  it('returns unknown-repo and creates no file when the registry did not exist', async () => {
    const registryFile = await tmpFile();

    const result = await setRepoState(registryFile, 'on-par/software-factory', 'paused');

    expect(result).toEqual({
      ok: false,
      reason: 'unknown-repo',
      detail: 'on-par/software-factory is not attached',
    });
    expect(existsSync(registryFile)).toBe(false);
  });

  it('returns unknown-repo and leaves an existing registry byte-for-byte unchanged', async () => {
    const registryFile = await tmpFile();
    const preSeeded = JSON.stringify({
      version: 1,
      repos: {
        'on-par/unrelated': { path: '/tmp/unrelated', attachedAt: '2026-01-01T00:00:00.000Z', state: 'active' },
      },
    });
    await writeFile(registryFile, preSeeded);

    const result = await setRepoState(registryFile, 'on-par/software-factory', 'paused');

    expect(result).toEqual({
      ok: false,
      reason: 'unknown-repo',
      detail: 'on-par/software-factory is not attached',
    });
    await expect(readFile(registryFile, 'utf-8')).resolves.toBe(preSeeded);
  });

  it('returns detached and leaves the file unchanged for a detached tombstone', async () => {
    const registryFile = await tmpFile();
    const registry = upsertRepo(emptyRegistry(), 'on-par/software-factory', {
      path: '/repos/software-factory',
      attachedAt: '2026-08-19T12:00:00.000Z',
      state: 'detached',
    });
    await writeRegistry(registryFile, registry);
    const before = await readFile(registryFile, 'utf-8');

    const result = await setRepoState(registryFile, 'on-par/software-factory', 'active');

    expect(result).toEqual({
      ok: false,
      reason: 'detached',
      detail: 'on-par/software-factory is detached; re-attach it with POST /repos',
    });
    await expect(readFile(registryFile, 'utf-8')).resolves.toBe(before);
  });

  it('returns draining and leaves the file unchanged when resuming a draining entry', async () => {
    const registryFile = await tmpFile();
    const registry = upsertRepo(emptyRegistry(), 'on-par/software-factory', {
      path: '/repos/software-factory',
      attachedAt: '2026-08-19T12:00:00.000Z',
      state: 'draining',
    });
    await writeRegistry(registryFile, registry);
    const before = await readFile(registryFile, 'utf-8');

    const result = await setRepoState(registryFile, 'on-par/software-factory', 'active');

    expect(result).toEqual({
      ok: false,
      reason: 'draining',
      detail:
        'on-par/software-factory is draining; wait for the detach to finish or force it with DELETE /repos/on-par/software-factory?force=true',
    });
    await expect(readFile(registryFile, 'utf-8')).resolves.toBe(before);
  });

  it('returns draining and leaves the file unchanged when pausing a draining entry', async () => {
    const registryFile = await tmpFile();
    const registry = upsertRepo(emptyRegistry(), 'on-par/software-factory', {
      path: '/repos/software-factory',
      attachedAt: '2026-08-19T12:00:00.000Z',
      state: 'draining',
    });
    await writeRegistry(registryFile, registry);
    const before = await readFile(registryFile, 'utf-8');

    const result = await setRepoState(registryFile, 'on-par/software-factory', 'paused');

    expect(result).toEqual({
      ok: false,
      reason: 'draining',
      detail:
        'on-par/software-factory is draining; wait for the detach to finish or force it with DELETE /repos/on-par/software-factory?force=true',
    });
    await expect(readFile(registryFile, 'utf-8')).resolves.toBe(before);
  });

  it('leaves sibling entries untouched when one repo is paused', async () => {
    const registryFile = await tmpFile();
    let registry = upsertRepo(emptyRegistry(), 'on-par/software-factory', {
      path: '/repos/software-factory',
      attachedAt: '2026-08-19T12:00:00.000Z',
      state: 'active',
    });
    registry = upsertRepo(registry, 'on-par/sibling', {
      path: '/repos/sibling',
      attachedAt: '2026-01-01T00:00:00.000Z',
      state: 'active',
    });
    await writeRegistry(registryFile, registry);

    await setRepoState(registryFile, 'on-par/software-factory', 'paused');

    const loaded = await loadRegistry(registryFile);
    expect(loaded.repos['on-par/sibling']).toEqual({
      path: '/repos/sibling',
      attachedAt: '2026-01-01T00:00:00.000Z',
      state: 'active',
    });
  });
});
