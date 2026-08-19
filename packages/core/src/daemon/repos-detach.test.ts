import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';

import { dispatchableRepos, emptyRegistry, loadRegistry, upsertRepo, writeRegistry } from './registry.js';
import { beginDetach, drainAndDetach, isDrainSafe } from './repos-detach.js';
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

const SAFE_STATUSES: RunStatus[] = ['pending', 'ready', 'awaiting-review', 'parked', 'escalated', 'merged', 'failed'];
const BLOCKING_STATUSES: RunStatus[] = ['planning', 'building', 'checking', 'reworking', 'shipping'];

describe('isDrainSafe', () => {
  it('is true for an empty list', () => {
    expect(isDrainSafe([])).toBe(true);
  });

  for (const status of SAFE_STATUSES) {
    it(`is true for [${status}]`, () => {
      expect(isDrainSafe([status])).toBe(true);
    });
  }

  for (const status of BLOCKING_STATUSES) {
    it(`is false for [${status}]`, () => {
      expect(isDrainSafe([status])).toBe(false);
    });
  }

  it('is false for a mixed list with one blocking status', () => {
    expect(isDrainSafe(['merged', 'building'])).toBe(false);
  });
});

describe('beginDetach', () => {
  it('writes draining for an active repo (force: false) and dispatchableRepos excludes it (acceptance criterion 1)', async () => {
    const registryFile = await tmpFile();
    await writeRegistry(
      registryFile,
      upsertRepo(emptyRegistry(), 'on-par/software-factory', {
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'active',
      }),
    );

    const result = await beginDetach(registryFile, 'on-par/software-factory', false);

    expect(result).toEqual({
      ok: true,
      draining: true,
      entry: {
        slug: 'on-par/software-factory',
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'draining',
      },
    });

    const loaded = await loadRegistry(registryFile);
    expect(loaded.repos['on-par/software-factory']).toEqual({
      path: '/repos/software-factory',
      attachedAt: '2026-08-19T12:00:00.000Z',
      state: 'draining',
    });
    expect(dispatchableRepos(loaded)).toEqual([]);
  });

  it('writes draining for a paused repo', async () => {
    const registryFile = await tmpFile();
    await writeRegistry(
      registryFile,
      upsertRepo(emptyRegistry(), 'on-par/software-factory', {
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'paused',
      }),
    );

    const result = await beginDetach(registryFile, 'on-par/software-factory', false);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.state).toBe('draining');
  });

  it('force: true tombstones an active repo immediately (acceptance criterion 2)', async () => {
    const registryFile = await tmpFile();
    await writeRegistry(
      registryFile,
      upsertRepo(emptyRegistry(), 'on-par/software-factory', {
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'active',
      }),
    );

    const result = await beginDetach(registryFile, 'on-par/software-factory', true);

    expect(result).toEqual({
      ok: true,
      draining: false,
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

  it('force: true on a draining entry tombstones it (the stuck-drain escape)', async () => {
    const registryFile = await tmpFile();
    await writeRegistry(
      registryFile,
      upsertRepo(emptyRegistry(), 'on-par/software-factory', {
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'draining',
      }),
    );

    const result = await beginDetach(registryFile, 'on-par/software-factory', true);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry.state).toBe('detached');
    const loaded = await loadRegistry(registryFile);
    expect(loaded.repos['on-par/software-factory']?.state).toBe('detached');
  });

  it('returns unknown-repo and creates no file when the registry did not exist', async () => {
    const registryFile = await tmpFile();

    const result = await beginDetach(registryFile, 'on-par/software-factory', false);

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

    const result = await beginDetach(registryFile, 'on-par/software-factory', false);

    expect(result).toEqual({
      ok: false,
      reason: 'unknown-repo',
      detail: 'on-par/software-factory is not attached',
    });
    await expect(readFile(registryFile, 'utf-8')).resolves.toBe(preSeeded);
  });

  it('is idempotent for an already-detached tombstone and leaves the file unchanged', async () => {
    const registryFile = await tmpFile();
    await writeRegistry(
      registryFile,
      upsertRepo(emptyRegistry(), 'on-par/software-factory', {
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'detached',
      }),
    );
    const before = await readFile(registryFile, 'utf-8');

    const result = await beginDetach(registryFile, 'on-par/software-factory', false);

    expect(result).toEqual({
      ok: true,
      draining: false,
      entry: {
        slug: 'on-par/software-factory',
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'detached',
      },
    });
    await expect(readFile(registryFile, 'utf-8')).resolves.toBe(before);
  });

  it('leaves a sibling entry untouched', async () => {
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

    await beginDetach(registryFile, 'on-par/software-factory', true);

    const loaded = await loadRegistry(registryFile);
    expect(loaded.repos['on-par/sibling']).toEqual({
      path: '/repos/sibling',
      attachedAt: '2026-01-01T00:00:00.000Z',
      state: 'active',
    });
  });
});

describe('drainAndDetach', () => {
  it('detaches only after the reader clears a blocking status (acceptance criterion 1)', async () => {
    const registryFile = await tmpFile();
    await writeRegistry(
      registryFile,
      upsertRepo(emptyRegistry(), 'on-par/software-factory', {
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'draining',
      }),
    );

    let call = 0;
    const readLaneStatuses = async (): Promise<RunStatus[]> => {
      call += 1;
      if (call === 1) return ['building'];
      if (call === 2) return ['building'];
      return ['merged'];
    };

    const outcome = await drainAndDetach(registryFile, 'on-par/software-factory', {
      readLaneStatuses,
      sleep: async () => {},
      pollIntervalMs: 0,
    });

    expect(outcome).toBe('detached');
    expect(call).toBe(3);
    const loaded = await loadRegistry(registryFile);
    expect(loaded.repos['on-par/software-factory']?.state).toBe('detached');
  });

  it('calls readLaneStatuses with the entry path', async () => {
    const registryFile = await tmpFile();
    await writeRegistry(
      registryFile,
      upsertRepo(emptyRegistry(), 'on-par/software-factory', {
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'draining',
      }),
    );

    const seenPaths: string[] = [];
    await drainAndDetach(registryFile, 'on-par/software-factory', {
      readLaneStatuses: async (repoPath) => {
        seenPaths.push(repoPath);
        return ['merged'];
      },
    });

    expect(seenPaths).toEqual(['/repos/software-factory']);
  });

  it('detaches on the first pass with the production default (no lanes)', async () => {
    const registryFile = await tmpFile();
    await writeRegistry(
      registryFile,
      upsertRepo(emptyRegistry(), 'on-par/software-factory', {
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'draining',
      }),
    );

    const outcome = await drainAndDetach(registryFile, 'on-par/software-factory');
    expect(outcome).toBe('detached');
  });

  it('times out when a lane never clears a blocking status', async () => {
    const registryFile = await tmpFile();
    await writeRegistry(
      registryFile,
      upsertRepo(emptyRegistry(), 'on-par/software-factory', {
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'draining',
      }),
    );

    let now = 0;
    const outcome = await drainAndDetach(registryFile, 'on-par/software-factory', {
      readLaneStatuses: async () => ['building'],
      now: () => {
        const value = now;
        now += 600;
        return value;
      },
      sleep: async () => {},
      drainTimeoutMs: 1_000,
      pollIntervalMs: 1,
    });

    expect(outcome).toBe('timed-out');
    const loaded = await loadRegistry(registryFile);
    expect(loaded.repos['on-par/software-factory']?.state).toBe('draining');
  });

  it('aborts immediately when the signal is already aborted, never calling the reader', async () => {
    const registryFile = await tmpFile();
    await writeRegistry(
      registryFile,
      upsertRepo(emptyRegistry(), 'on-par/software-factory', {
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'draining',
      }),
    );

    const readLaneStatuses = async (): Promise<RunStatus[]> => {
      throw new Error('must not be called when aborted');
    };

    const outcome = await drainAndDetach(registryFile, 'on-par/software-factory', {
      readLaneStatuses,
      signal: { aborted: true },
    });

    expect(outcome).toBe('aborted');
    const loaded = await loadRegistry(registryFile);
    expect(loaded.repos['on-par/software-factory']?.state).toBe('draining');
  });

  it('is superseded when the entry is not draining, without calling the reader', async () => {
    const registryFile = await tmpFile();
    await writeRegistry(
      registryFile,
      upsertRepo(emptyRegistry(), 'on-par/software-factory', {
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'detached',
      }),
    );
    const before = await readFile(registryFile, 'utf-8');

    const readLaneStatuses = async (): Promise<RunStatus[]> => {
      throw new Error('must not be called when superseded');
    };

    const outcome = await drainAndDetach(registryFile, 'on-par/software-factory', { readLaneStatuses });

    expect(outcome).toBe('superseded');
    await expect(readFile(registryFile, 'utf-8')).resolves.toBe(before);
  });

  it('is superseded when a force-detach races ahead mid-drain', async () => {
    const registryFile = await tmpFile();
    await writeRegistry(
      registryFile,
      upsertRepo(emptyRegistry(), 'on-par/software-factory', {
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'draining',
      }),
    );

    let firstCall = true;
    const readLaneStatuses = async (): Promise<RunStatus[]> => {
      if (firstCall) {
        firstCall = false;
        await beginDetach(registryFile, 'on-par/software-factory', true);
        return ['building'];
      }
      throw new Error('must not be called again after superseded');
    };

    const outcome = await drainAndDetach(registryFile, 'on-par/software-factory', {
      readLaneStatuses,
      sleep: async () => {},
      pollIntervalMs: 0,
    });

    expect(outcome).toBe('superseded');
  });

  it('survives a third repo attached mid-drain and does not clobber it on the terminal write', async () => {
    const registryFile = await tmpFile();
    await writeRegistry(
      registryFile,
      upsertRepo(emptyRegistry(), 'on-par/software-factory', {
        path: '/repos/software-factory',
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'draining',
      }),
    );

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

    await drainAndDetach(registryFile, 'on-par/software-factory', {
      readLaneStatuses,
      sleep: async () => {},
      pollIntervalMs: 0,
    });

    const loaded = await loadRegistry(registryFile);
    expect(loaded.repos['on-par/late-arrival']).toEqual({
      path: '/repos/late-arrival',
      attachedAt: '2026-02-02T00:00:00.000Z',
      state: 'active',
    });
    expect(loaded.repos['on-par/software-factory']?.state).toBe('detached');
  });
});

describe('detach leaves the repo checkout .factory/ directory untouched', () => {
  it('is identical after a full drain and after a force detach (both acceptance criteria)', async () => {
    const checkoutDir = await mkdtemp(join(tmpdir(), 'repos-detach-checkout-'));
    tmpDirs.push(checkoutDir);
    const factoryDir = join(checkoutDir, '.factory');
    const plansDir = join(factoryDir, 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(factoryDir, 'config.json'), '{"repo":"on-par/x"}\n');
    await writeFile(join(factoryDir, 'events.ndjson'), '{"type":"noop"}\n');
    await writeFile(join(plansDir, 'issue-1.md'), '# plan\n');

    const files = [join(factoryDir, 'config.json'), join(factoryDir, 'events.ndjson'), join(plansDir, 'issue-1.md')];
    const before = await Promise.all(
      files.map(async (f) => ({ file: f, content: await readFile(f, 'utf-8'), mtimeMs: (await stat(f)).mtimeMs })),
    );

    // Default drain path.
    const registryFile1 = await tmpFile();
    await writeRegistry(
      registryFile1,
      upsertRepo(emptyRegistry(), 'on-par/x', {
        path: checkoutDir,
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'active',
      }),
    );
    await beginDetach(registryFile1, 'on-par/x', false);
    await drainAndDetach(registryFile1, 'on-par/x', { readLaneStatuses: async () => ['merged'] });

    // Forced path.
    const registryFile2 = await tmpFile();
    await writeRegistry(
      registryFile2,
      upsertRepo(emptyRegistry(), 'on-par/x', {
        path: checkoutDir,
        attachedAt: '2026-08-19T12:00:00.000Z',
        state: 'active',
      }),
    );
    await beginDetach(registryFile2, 'on-par/x', true);

    const after = await Promise.all(
      files.map(async (f) => ({ file: f, content: await readFile(f, 'utf-8'), mtimeMs: (await stat(f)).mtimeMs })),
    );
    expect(after).toEqual(before);
  });
});
