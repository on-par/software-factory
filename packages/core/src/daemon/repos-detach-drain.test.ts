import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { emptyRegistry, loadRegistry, upsertRepo, writeRegistry } from './registry.js';
import { drainAndDetach } from './repos-detach.js';
import { setRepoState } from './repos-pause-resume.js';

const tmpDirs: string[] = [];

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'repos-detach-drain-test-'));
  tmpDirs.push(dir);
  return join(dir, 'registry.json');
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('drainAndDetach under the registry lock', () => {
  it('keeps a pause of another repo written while the drain is polling', async () => {
    const registryFile = await tmpFile();
    const base = { path: '/repos/x', attachedAt: '2026-08-19T12:00:00.000Z' };
    await writeRegistry(
      registryFile,
      upsertRepo(upsertRepo(emptyRegistry(), 'on-par/x', { ...base, state: 'active' }), 'on-par/y', {
        ...base,
        state: 'draining',
      }),
    );

    const outcome = await drainAndDetach(registryFile, 'on-par/y', {
      readLaneStatuses: async () => {
        await setRepoState(registryFile, 'on-par/x', 'paused');
        return [];
      },
    });

    expect(outcome).toBe('detached');
    const loaded = await loadRegistry(registryFile);
    expect(loaded.repos['on-par/x']?.state).toBe('paused');
    expect(loaded.repos['on-par/y']?.state).toBe('detached');
  });

  it('reports superseded and does not tombstone when the entry stops draining between poll and write', async () => {
    const registryFile = await tmpFile();
    const base = { path: '/repos/y', attachedAt: '2026-08-19T12:00:00.000Z' };
    await writeRegistry(registryFile, upsertRepo(emptyRegistry(), 'on-par/y', { ...base, state: 'draining' }));

    const outcome = await drainAndDetach(registryFile, 'on-par/y', {
      readLaneStatuses: async () => {
        await writeRegistry(registryFile, upsertRepo(emptyRegistry(), 'on-par/y', { ...base, state: 'active' }));
        return [];
      },
    });

    expect(outcome).toBe('superseded');
    expect((await loadRegistry(registryFile)).repos['on-par/y']?.state).toBe('active');
  });
});
