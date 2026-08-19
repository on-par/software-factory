import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { dispatchableRepos, emptyRegistry, loadRegistry, upsertRepo, writeRegistry } from './registry.js';
import { detachRepo, isSafeDetachBoundary, SAFE_DETACH_STATUSES } from './repos-detach.js';
import type { RunStatus } from '../types/index.js';

const tmpDirs: string[] = [];

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'repos-detach-test-'));
  tmpDirs.push(dir);
  return join(dir, 'registry.json');
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const SAFE_STATUSES: RunStatus[] = ['ready', 'awaiting-review', 'parked', 'escalated', 'merged', 'failed'];
const UNSAFE_STATUSES: RunStatus[] = ['pending', 'planning', 'building', 'checking', 'reworking', 'shipping'];

describe('isSafeDetachBoundary / SAFE_DETACH_STATUSES', () => {
  it('names exactly the six safe statuses', () => {
    expect([...SAFE_DETACH_STATUSES].sort()).toEqual([...SAFE_STATUSES].sort());
  });

  for (const status of SAFE_STATUSES) {
    it(`treats ${status} as a safe boundary`, () => {
      expect(isSafeDetachBoundary(status)).toBe(true);
    });
  }

  for (const status of UNSAFE_STATUSES) {
    it(`treats ${status} as unsafe (in-flight)`, () => {
      expect(isSafeDetachBoundary(status)).toBe(false);
    });
  }
});

describe('detachRepo', () => {
  it('drains before tombstoning (acceptance criterion 1)', async () => {
    const registryFile = await tmpFile();
    const registry = upsertRepo(emptyRegistry(), 'on-par/software-factory', {
      path: '/repos/software-factory',
      attachedAt: '2026-08-19T12:00:00.000Z',
      state: 'active',
    });
    await writeRegistry(registryFile, registry);

    let call = 0;
    const readLaneStatuses = async (): Promise<RunStatus[]> => {
      call += 1;
      if (call === 1) return ['building'];
      if (call === 2) return ['checking'];
      return ['merged'];
    };
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    const result = await detachRepo(registryFile, 'on-par/software-factory', { readLaneStatuses, sleep });

    expect(result).toEqual({
      ok: true,
      forced: false,
      entry: {
        slug: 'on-par/software-factory',
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'detached',
      },
    });
    expect(call).toBe(3);
    expect(sleepCalls.length).toBe(2);

    const loaded = await loadRegistry(registryFile);
    expect(loaded.repos['on-par/software-factory']).toEqual({
      path: '/repos/software-factory',
      attachedAt: '2026-08-19T12:00:00.000Z',
      state: 'detached',
    });
  });

  it('writes draining before it waits (the stop-claiming guarantee)', async () => {
    const registryFile = await tmpFile();
    const registry = upsertRepo(emptyRegistry(), 'on-par/software-factory', {
      path: '/repos/software-factory',
      attachedAt: '2026-08-19T12:00:00.000Z',
      state: 'active',
    });
    await writeRegistry(registryFile, registry);

    let firstCall = true;
    const readLaneStatuses = async (slug: string): Promise<RunStatus[]> => {
      if (firstCall) {
        firstCall = false;
        const loaded = await loadRegistry(registryFile);
        expect(loaded.repos[slug]?.state).toBe('draining');
        expect(dispatchableRepos(loaded).map((r) => r.slug)).not.toContain(slug);
      }
      return ['merged'];
    };

    const result = await detachRepo(registryFile, 'on-par/software-factory', { readLaneStatuses });
    expect(result.ok).toBe(true);
  });

  for (const status of SAFE_STATUSES) {
    it(`detaches on the first poll when the only lane is ${status}, without sleeping`, async () => {
      const registryFile = await tmpFile();
      const registry = upsertRepo(emptyRegistry(), 'on-par/software-factory', {
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'active',
      });
      await writeRegistry(registryFile, registry);

      const sleep = async () => {
        throw new Error('must not sleep for a safe boundary');
      };
      const result = await detachRepo(registryFile, 'on-par/software-factory', {
        readLaneStatuses: async () => [status],
        sleep,
      });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.entry.state).toBe('detached');
    });
  }

  for (const status of ['pending', 'shipping'] as RunStatus[]) {
    it(`blocks the drain on unsafe status ${status} until timeout`, async () => {
      const registryFile = await tmpFile();
      const registry = upsertRepo(emptyRegistry(), 'on-par/software-factory', {
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'active',
      });
      await writeRegistry(registryFile, registry);

      let now = 0;
      const result = await detachRepo(registryFile, 'on-par/software-factory', {
        readLaneStatuses: async () => [status],
        now: () => {
          const value = now;
          now += 600;
          return value;
        },
        sleep: async () => {},
        drainTimeoutMs: 1_000,
        pollIntervalMs: 1,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('drain-timeout');
        expect(result.detail).toContain('?force=true');
      }

      const loaded = await loadRegistry(registryFile);
      expect(loaded.repos['on-par/software-factory']?.state).toBe('draining');
    });
  }

  it('force skips the drain (acceptance criterion 2)', async () => {
    const registryFile = await tmpFile();
    const registry = upsertRepo(emptyRegistry(), 'on-par/software-factory', {
      path: '/repos/software-factory',
      attachedAt: '2026-08-19T12:00:00.000Z',
      state: 'active',
    });
    await writeRegistry(registryFile, registry);

    const result = await detachRepo(registryFile, 'on-par/software-factory', {
      force: true,
      readLaneStatuses: async () => {
        throw new Error('must not be called');
      },
    });

    expect(result).toEqual({
      ok: true,
      forced: true,
      entry: {
        slug: 'on-par/software-factory',
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'detached',
      },
    });

    const loaded = await loadRegistry(registryFile);
    expect(loaded.repos['on-par/software-factory']?.state).toBe('detached');
  });

  it('leaves the target repo checkout .factory/ directory untouched (both acceptance criteria)', async () => {
    const checkoutDir = await mkdtemp(join(tmpdir(), 'repos-detach-checkout-'));
    tmpDirs.push(checkoutDir);
    const factoryDir = join(checkoutDir, '.factory');
    const plansDir = join(factoryDir, 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(factoryDir, 'config.json'), '{"repo":"on-par/x"}\n');
    await writeFile(join(plansDir, 'x.md'), '# plan\n');

    const files = [join(factoryDir, 'config.json'), join(plansDir, 'x.md')];
    const before = await Promise.all(
      files.map(async (f) => ({ file: f, content: await readFile(f, 'utf-8'), mtimeMs: (await stat(f)).mtimeMs })),
    );

    // Default drain path
    const registryFile1 = await tmpFile();
    await writeRegistry(
      registryFile1,
      upsertRepo(emptyRegistry(), 'on-par/x', {
        path: checkoutDir,
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'active',
      }),
    );
    await detachRepo(registryFile1, 'on-par/x', { readLaneStatuses: async () => ['merged'] });

    // Forced path
    const registryFile2 = await tmpFile();
    await writeRegistry(
      registryFile2,
      upsertRepo(emptyRegistry(), 'on-par/x', {
        path: checkoutDir,
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'active',
      }),
    );
    await detachRepo(registryFile2, 'on-par/x', { force: true });

    const after = await Promise.all(
      files.map(async (f) => ({ file: f, content: await readFile(f, 'utf-8'), mtimeMs: (await stat(f)).mtimeMs })),
    );
    expect(after).toEqual(before);
  });

  it('returns unknown-repo and creates no file when the registry did not exist', async () => {
    const registryFile = await tmpFile();

    const result = await detachRepo(registryFile, 'on-par/software-factory');

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

    const result = await detachRepo(registryFile, 'on-par/software-factory');

    expect(result).toEqual({
      ok: false,
      reason: 'unknown-repo',
      detail: 'on-par/software-factory is not attached',
    });
    await expect(readFile(registryFile, 'utf-8')).resolves.toBe(preSeeded);
  });

  it('is idempotent for an already-detached tombstone and leaves the file unchanged', async () => {
    const registryFile = await tmpFile();
    const registry = upsertRepo(emptyRegistry(), 'on-par/software-factory', {
      path: '/repos/software-factory',
      attachedAt: '2026-08-19T12:00:00.000Z',
      state: 'detached',
    });
    await writeRegistry(registryFile, registry);
    const before = await readFile(registryFile, 'utf-8');

    const result = await detachRepo(registryFile, 'on-par/software-factory');

    expect(result).toEqual({
      ok: true,
      forced: false,
      entry: {
        slug: 'on-par/software-factory',
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'detached',
      },
    });
    await expect(readFile(registryFile, 'utf-8')).resolves.toBe(before);
  });

  it('detaches a paused entry normally', async () => {
    const registryFile = await tmpFile();
    const registry = upsertRepo(emptyRegistry(), 'on-par/software-factory', {
      path: '/repos/software-factory',
      attachedAt: '2026-08-19T12:00:00.000Z',
      state: 'paused',
    });
    await writeRegistry(registryFile, registry);

    const result = await detachRepo(registryFile, 'on-par/software-factory', {
      readLaneStatuses: async () => ['merged'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.state).toBe('detached');
  });

  it('resumes an interrupted drain: an entry already draining detaches without a second interim write', async () => {
    const registryFile = await tmpFile();
    const registry = upsertRepo(emptyRegistry(), 'on-par/software-factory', {
      path: '/repos/software-factory',
      attachedAt: '2026-08-19T12:00:00.000Z',
      state: 'draining',
    });
    await writeRegistry(registryFile, registry);

    const result = await detachRepo(registryFile, 'on-par/software-factory', {
      readLaneStatuses: async () => ['merged'],
    });

    expect(result).toEqual({
      ok: true,
      forced: false,
      entry: {
        slug: 'on-par/software-factory',
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'detached',
      },
    });
  });

  it('leaves a sibling entry untouched after a detach', async () => {
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

    await detachRepo(registryFile, 'on-par/software-factory', { force: true });

    const loaded = await loadRegistry(registryFile);
    expect(loaded.repos['on-par/sibling']).toEqual({
      path: '/repos/sibling',
      attachedAt: '2026-01-01T00:00:00.000Z',
      state: 'active',
    });
  });

  it('a third repo attached mid-drain survives the post-drain re-load and final write', async () => {
    const registryFile = await tmpFile();
    const registry = upsertRepo(emptyRegistry(), 'on-par/software-factory', {
      path: '/repos/software-factory',
      attachedAt: '2026-08-19T12:00:00.000Z',
      state: 'active',
    });
    await writeRegistry(registryFile, registry);

    let firstCall = true;
    const readLaneStatuses = async (): Promise<RunStatus[]> => {
      if (firstCall) {
        firstCall = false;
        const mid = await loadRegistry(registryFile);
        await writeRegistry(
          registryFile,
          upsertRepo(mid, 'on-par/late-arrival', {
            path: '/repos/late-arrival',
            attachedAt: '2026-02-02T00:00:00.000Z',
            state: 'active',
          }),
        );
        return ['building'];
      }
      return ['merged'];
    };

    await detachRepo(registryFile, 'on-par/software-factory', { readLaneStatuses });

    const loaded = await loadRegistry(registryFile);
    expect(loaded.repos['on-par/late-arrival']).toEqual({
      path: '/repos/late-arrival',
      attachedAt: '2026-02-02T00:00:00.000Z',
      state: 'active',
    });
    expect(loaded.repos['on-par/software-factory']?.state).toBe('detached');
  });

  it('uses the default seams (no lanes, real sleep, real clock) when none are injected', async () => {
    const registryFile = await tmpFile();
    const registry = upsertRepo(emptyRegistry(), 'on-par/software-factory', {
      path: '/repos/software-factory',
      attachedAt: '2026-08-19T12:00:00.000Z',
      state: 'active',
    });
    await writeRegistry(registryFile, registry);

    const result = await detachRepo(registryFile, 'on-par/software-factory');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.state).toBe('detached');
      expect(result.forced).toBe(false);
    }
  });
});
