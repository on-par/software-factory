import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  acquirePortLease,
  defaultIsPidAlive,
  defaultIsPortFree,
  headlessEnv,
  inspectPortLeases,
  laneEnv,
  leaseEnv,
  PortLeaseError,
  readPortLeases,
  reapStalePortLeases,
  recordLeasePgid,
  releasePortLease,
} from './index.js';

const LOCK_OPTS = { pollMs: 5 };
const alwaysFree = async () => true;
const liveProbes = { isPidAlive: () => true, worktreeExists: () => true };
const DEAD_PID = 4999999;

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ports-registry-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('acquirePortLease', () => {
  it('grants distinct ports to distinct worktrees, both persisted', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');

      const a = await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/a',
        branch: 'a',
        range: [3100, 3999],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });
      const b = await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/b',
        branch: 'b',
        range: [3100, 3999],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });

      expect(a.port).not.toBe(b.port);

      const registry = JSON.parse(await readFile(registryFile, 'utf-8'));
      expect(registry.leases).toHaveLength(2);
      expect(registry.leases.map((l: { port: number }) => l.port).sort()).toEqual([a.port, b.port].sort());
    });
  });

  it('is idempotent per worktreeId', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');
      const opts = {
        registryFile,
        lockDir,
        worktreeId: '/wt/a',
        branch: 'a',
        range: [3100, 3999] as [number, number],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      };

      const first = await acquirePortLease(opts);
      const second = await acquirePortLease(opts);

      expect(second.port).toBe(first.port);
      const registry = JSON.parse(await readFile(registryFile, 'utf-8'));
      expect(registry.leases.filter((l: { worktreeId: string }) => l.worktreeId === '/wt/a')).toHaveLength(1);
    });
  });

  it('grants pairwise-distinct ports under concurrent acquisition, repeatedly', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');
      const range: [number, number] = [3100, 3999];

      for (let iter = 0; iter < 50; iter++) {
        const worktreeIds = Array.from({ length: 20 }, (_, i) => `/wt/iter${iter}/${i}`);
        const leases = await Promise.all(
          worktreeIds.map((worktreeId) =>
            acquirePortLease({
              registryFile,
              lockDir,
              worktreeId,
              branch: 'b',
              range,
              isPortFree: alwaysFree,
              probes: liveProbes,
              lockOpts: LOCK_OPTS,
            }),
          ),
        );

        const ports = leases.map((l) => l.port);
        expect(new Set(ports).size).toBe(ports.length);

        const registry = JSON.parse(await readFile(registryFile, 'utf-8'));
        expect(registry.leases).toHaveLength(20);
        expect(new Set(registry.leases.map((l: { port: number }) => l.port))).toEqual(new Set(ports));

        await Promise.all(
          worktreeIds.map((worktreeId) => releasePortLease({ registryFile, lockDir, worktreeId, lockOpts: LOCK_OPTS })),
        );
      }
    });
  }, 30_000);

  it('skips an externally-bound port using the real bind probe', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');

      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, () => resolve()));
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : 0;

      try {
        const lease = await acquirePortLease({
          registryFile,
          lockDir,
          worktreeId: '/wt/a',
          branch: 'a',
          range: [boundPort, boundPort + 10],
          isPortFree: defaultIsPortFree,
          lockOpts: LOCK_OPTS,
        });

        expect(lease.port).not.toBe(boundPort);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  it('throws PortLeaseError when the range is exhausted', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');

      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/a',
        branch: 'a',
        range: [3100, 3100],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });

      await expect(
        acquirePortLease({
          registryFile,
          lockDir,
          worktreeId: '/wt/b',
          branch: 'b',
          range: [3100, 3100],
          isPortFree: alwaysFree,
          probes: liveProbes,
          lockOpts: LOCK_OPTS,
        }),
      ).rejects.toThrow(PortLeaseError);
    });
  });

  it('treats corrupt/garbage ports.json as empty', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(registryFile, 'not json{{{');

      const lease = await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/a',
        branch: 'a',
        range: [3100, 3999],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });

      expect(lease.port).toBe(3100);
    });
  });
});

describe('defaultIsPortFree', () => {
  it('returns false while a port is bound and true once freed', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    expect(await defaultIsPortFree(port)).toBe(false);

    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(await defaultIsPortFree(port)).toBe(true);
  });
});

describe('releasePortLease', () => {
  it('removes the entry for the given worktreeId', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');
      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/a',
        branch: 'a',
        range: [3100, 3999],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });

      await releasePortLease({ registryFile, lockDir, worktreeId: '/wt/a', lockOpts: LOCK_OPTS });

      const registry = JSON.parse(await readFile(registryFile, 'utf-8'));
      expect(registry.leases).toHaveLength(0);
    });
  });

  it('is a no-op releasing an unknown worktreeId', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');
      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/a',
        branch: 'a',
        range: [3100, 3999],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });

      await expect(
        releasePortLease({ registryFile, lockDir, worktreeId: '/wt/unknown', lockOpts: LOCK_OPTS }),
      ).resolves.toBeUndefined();

      const registry = JSON.parse(await readFile(registryFile, 'utf-8'));
      expect(registry.leases).toHaveLength(1);
    });
  });

  it('is a no-op when the registry file does not exist', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');

      await expect(
        releasePortLease({ registryFile, lockDir, worktreeId: '/wt/a', lockOpts: LOCK_OPTS }),
      ).resolves.toBeUndefined();
    });
  });
});

describe('leaseEnv', () => {
  it('derives PORT/FACTORY_APP_PORT/FACTORY_BASE_URL from the leased port', () => {
    expect(leaseEnv(3142)).toEqual({
      PORT: '3142',
      FACTORY_APP_PORT: '3142',
      FACTORY_BASE_URL: 'http://127.0.0.1:3142',
    });
  });

  it('overrides FACTORY_BASE_URL with a stable lane URL while PORT/FACTORY_APP_PORT stay the raw port', () => {
    expect(leaseEnv(3142, 'http://ship-it-296.factory.localhost')).toEqual({
      PORT: '3142',
      FACTORY_APP_PORT: '3142',
      FACTORY_BASE_URL: 'http://ship-it-296.factory.localhost',
    });
  });
});

describe('readPortLeases', () => {
  it('returns the leases persisted in the registry file', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'lock');
      const lease = await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: dir,
        branch: 'ship-it/x',
        range: [4100, 4110],
        isPortFree: alwaysFree,
        lockOpts: LOCK_OPTS,
      });
      expect(readPortLeases(registryFile)).toEqual([lease]);
    });
  });

  it('returns an empty array when the registry file is missing', () => {
    expect(readPortLeases('/nonexistent/ports.json')).toEqual([]);
  });
});

describe('headlessEnv', () => {
  it('returns the headless pair for an empty parent env', () => {
    expect(headlessEnv({})).toEqual({ FACTORY_HEADLESS: '1', PLAYWRIGHT_HEADLESS: '1' });
  });

  it('returns an empty object when the parent env explicitly opts out', () => {
    expect(headlessEnv({ FACTORY_HEADLESS: '0' })).toEqual({});
  });
});

describe('laneEnv', () => {
  it('returns all five vars when a port is leased', () => {
    expect(laneEnv(3142, {})).toEqual({
      FACTORY_HEADLESS: '1',
      PLAYWRIGHT_HEADLESS: '1',
      PORT: '3142',
      FACTORY_APP_PORT: '3142',
      FACTORY_BASE_URL: 'http://127.0.0.1:3142',
    });
  });

  it('returns only the headless pair when no port is leased', () => {
    expect(laneEnv(undefined, {})).toEqual({ FACTORY_HEADLESS: '1', PLAYWRIGHT_HEADLESS: '1' });
  });

  it('returns exactly leaseEnv(port) when the parent env opts out of headless', () => {
    expect(laneEnv(3142, { FACTORY_HEADLESS: '0' })).toEqual(leaseEnv(3142));
  });

  it('forwards baseUrl through to leaseEnv', () => {
    expect(laneEnv(3142, {}, 'http://ship-it-296.factory.localhost')).toEqual({
      FACTORY_HEADLESS: '1',
      PLAYWRIGHT_HEADLESS: '1',
      PORT: '3142',
      FACTORY_APP_PORT: '3142',
      FACTORY_BASE_URL: 'http://ship-it-296.factory.localhost',
    });
  });
});

describe('acquirePortLease reaping', () => {
  it('reaps a dead-pid lease and reports it via onReap', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');

      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/dead',
        branch: 'dead',
        range: [3100, 3999],
        pid: DEAD_PID,
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });

      const onReap = vi.fn();
      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/b',
        branch: 'b',
        range: [3100, 3999],
        isPortFree: alwaysFree,
        probes: { isPidAlive: (pid) => pid !== DEAD_PID, worktreeExists: () => true },
        onReap,
        lockOpts: LOCK_OPTS,
      });

      expect(onReap).toHaveBeenCalledTimes(1);
      expect(onReap.mock.calls[0][0]).toMatchObject({
        reason: 'dead-pid',
        lease: { worktreeId: '/wt/dead' },
      });

      const registry = JSON.parse(await readFile(registryFile, 'utf-8'));
      expect(registry.leases.map((l: { worktreeId: string }) => l.worktreeId)).not.toContain('/wt/dead');
    });
  });

  it('reaps a missing-worktree lease', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');

      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/gone',
        branch: 'gone',
        range: [3100, 3999],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });

      const onReap = vi.fn();
      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/b',
        branch: 'b',
        range: [3100, 3999],
        isPortFree: alwaysFree,
        probes: { isPidAlive: () => true, worktreeExists: (p) => p !== '/wt/gone' },
        onReap,
        lockOpts: LOCK_OPTS,
      });

      expect(onReap).toHaveBeenCalledTimes(1);
      expect(onReap.mock.calls[0][0]).toMatchObject({ reason: 'missing-worktree' });
    });
  });

  it('reports dead-pid when both pid and worktree checks fail', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');

      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/both-bad',
        branch: 'both-bad',
        range: [3100, 3999],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });

      const onReap = vi.fn();
      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/b',
        branch: 'b',
        range: [3100, 3999],
        isPortFree: alwaysFree,
        probes: { isPidAlive: () => false, worktreeExists: () => false },
        onReap,
        lockOpts: LOCK_OPTS,
      });

      expect(onReap).toHaveBeenCalledTimes(1);
      expect(onReap.mock.calls[0][0]).toMatchObject({ reason: 'dead-pid' });
    });
  });

  it('frees the reaped port for re-allocation', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');

      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/dead',
        branch: 'dead',
        range: [3100, 3100],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });

      const lease = await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/b',
        branch: 'b',
        range: [3100, 3100],
        isPortFree: alwaysFree,
        probes: { isPidAlive: () => false, worktreeExists: () => true },
        lockOpts: LOCK_OPTS,
      });

      expect(lease.port).toBe(3100);
    });
  });

  it('recovers a SIGKILLed lease for the same worktree with a fresh pid', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');

      const first = await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/a',
        branch: 'a',
        range: [3100, 3999],
        pid: DEAD_PID,
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });

      const second = await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/a',
        branch: 'a',
        range: [3100, 3999],
        pid: process.pid,
        isPortFree: alwaysFree,
        probes: { isPidAlive: (pid) => pid !== DEAD_PID, worktreeExists: () => true },
        lockOpts: LOCK_OPTS,
      });

      expect(second.pid).toBe(process.pid);
      expect(second.pid).not.toBe(first.pid);

      const registry = JSON.parse(await readFile(registryFile, 'utf-8'));
      const aLeases = registry.leases.filter((l: { worktreeId: string }) => l.worktreeId === '/wt/a');
      expect(aLeases).toHaveLength(1);
    });
  });

  it('leaves live leases untouched and never calls onReap', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');

      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/a',
        branch: 'a',
        range: [3100, 3999],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });
      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/b',
        branch: 'b',
        range: [3100, 3999],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });

      const onReap = vi.fn();
      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/c',
        branch: 'c',
        range: [3100, 3999],
        isPortFree: alwaysFree,
        probes: liveProbes,
        onReap,
        lockOpts: LOCK_OPTS,
      });

      expect(onReap).not.toHaveBeenCalled();
      const registry = JSON.parse(await readFile(registryFile, 'utf-8'));
      expect(registry.leases.map((l: { worktreeId: string }) => l.worktreeId).sort()).toEqual([
        '/wt/a',
        '/wt/b',
        '/wt/c',
      ]);
    });
  });
});

describe('reapStalePortLeases', () => {
  it('removes stale leases and returns them with reasons, leaving live leases intact', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');

      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/live',
        branch: 'live',
        range: [3100, 3999],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });
      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/dead',
        branch: 'dead',
        range: [3100, 3999],
        pid: DEAD_PID,
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });
      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/gone',
        branch: 'gone',
        range: [3100, 3999],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });

      const reaped = await reapStalePortLeases({
        registryFile,
        lockDir,
        probes: {
          isPidAlive: (pid) => pid !== DEAD_PID,
          worktreeExists: (p) => p !== '/wt/gone',
        },
        lockOpts: LOCK_OPTS,
      });

      expect(reaped.map((r) => r.lease.worktreeId).sort()).toEqual(['/wt/dead', '/wt/gone']);
      const deadReap = reaped.find((r) => r.lease.worktreeId === '/wt/dead')!;
      const goneReap = reaped.find((r) => r.lease.worktreeId === '/wt/gone')!;
      expect(deadReap.reason).toBe('dead-pid');
      expect(goneReap.reason).toBe('missing-worktree');

      const registry = JSON.parse(await readFile(registryFile, 'utf-8'));
      expect(registry.leases).toHaveLength(1);
      expect(registry.leases[0].worktreeId).toBe('/wt/live');
    });
  });

  it('resolves to [] when the registry file does not exist', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');

      const reaped = await reapStalePortLeases({ registryFile, lockDir, lockOpts: LOCK_OPTS });
      expect(reaped).toEqual([]);
    });
  });
});

describe('inspectPortLeases', () => {
  it('reports live and stale rows with reasons and portSquatted, without mutating the registry', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');

      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/live',
        branch: 'live',
        range: [3100, 3100],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });
      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/dead',
        branch: 'dead',
        range: [3200, 3200],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });

      const before = await readFile(registryFile, 'utf-8');

      const health = await inspectPortLeases({
        registryFile,
        probes: { isPidAlive: () => true, worktreeExists: (p) => p !== '/wt/dead' },
        isPortFree: async (p) => p !== 3200,
      });

      const after = await readFile(registryFile, 'utf-8');
      expect(after).toBe(before);

      const live = health.find((h) => h.lease.worktreeId === '/wt/live')!;
      expect(live.alive).toBe(true);
      expect(live.reason).toBeUndefined();

      const dead = health.find((h) => h.lease.worktreeId === '/wt/dead')!;
      expect(dead.alive).toBe(false);
      expect(dead.reason).toBe('missing-worktree');
      expect(dead.portSquatted).toBe(true);
    });
  });

  it('reports portSquatted=false when the stale port is free', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');

      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/dead',
        branch: 'dead',
        range: [3200, 3200],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });

      const health = await inspectPortLeases({
        registryFile,
        probes: { isPidAlive: () => false, worktreeExists: () => true },
        isPortFree: alwaysFree,
      });

      expect(health).toHaveLength(1);
      expect(health[0].alive).toBe(false);
      expect(health[0].reason).toBe('dead-pid');
      expect(health[0].portSquatted).toBe(false);
    });
  });

  it('resolves to [] for a missing or corrupt registry', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');

      expect(await inspectPortLeases({ registryFile })).toEqual([]);

      await writeFile(registryFile, 'not json{{{');
      expect(await inspectPortLeases({ registryFile })).toEqual([]);
    });
  });
});

describe('defaultIsPidAlive', () => {
  it('is true for the current process', () => {
    expect(defaultIsPidAlive(process.pid)).toBe(true);
  });

  it('is false for a guaranteed-dead pid', () => {
    const result = spawnSync(process.execPath, ['-e', '""']);
    const exitedPid = result.pid ?? 2 ** 30;
    expect(defaultIsPidAlive(exitedPid)).toBe(false);
  });
});

describe('recordLeasePgid', () => {
  it('appends a pgid to the matching lease', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');

      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/a',
        branch: 'a',
        range: [3300, 3300],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });

      await recordLeasePgid({ registryFile, lockDir, worktreeId: '/wt/a', pgid: 111, lockOpts: LOCK_OPTS });

      const raw = JSON.parse(await readFile(registryFile, 'utf-8'));
      const lease = raw.leases.find((l: any) => l.worktreeId === '/wt/a');
      expect(lease.pgids).toEqual([111]);
    });
  });

  it('dedupes repeated pgids', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');

      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/a',
        branch: 'a',
        range: [3301, 3301],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });

      await recordLeasePgid({ registryFile, lockDir, worktreeId: '/wt/a', pgid: 111, lockOpts: LOCK_OPTS });
      await recordLeasePgid({ registryFile, lockDir, worktreeId: '/wt/a', pgid: 111, lockOpts: LOCK_OPTS });

      const raw = JSON.parse(await readFile(registryFile, 'utf-8'));
      const lease = raw.leases.find((l: any) => l.worktreeId === '/wt/a');
      expect(lease.pgids).toEqual([111]);
    });
  });

  it('caps recorded pgids at 64', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');

      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/a',
        branch: 'a',
        range: [3302, 3302],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });

      for (let i = 0; i < 70; i++) {
        await recordLeasePgid({ registryFile, lockDir, worktreeId: '/wt/a', pgid: i, lockOpts: LOCK_OPTS });
      }

      const raw = JSON.parse(await readFile(registryFile, 'utf-8'));
      const lease = raw.leases.find((l: any) => l.worktreeId === '/wt/a');
      expect(lease.pgids).toHaveLength(64);
      expect(lease.pgids[63]).toBe(69);
    });
  });

  it('no-ops when the lease is missing', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');

      await recordLeasePgid({ registryFile, lockDir, worktreeId: '/wt/missing', pgid: 1, lockOpts: LOCK_OPTS });

      expect(existsSync(registryFile)).toBe(false);
    });
  });

  it('a lease with pgids round-trips through acquire-idempotency and survives release filtering of others', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');

      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/a',
        branch: 'a',
        range: [3303, 3304],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });
      await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/b',
        branch: 'b',
        range: [3303, 3304],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });

      await recordLeasePgid({ registryFile, lockDir, worktreeId: '/wt/a', pgid: 42, lockOpts: LOCK_OPTS });

      const again = await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/a',
        branch: 'a',
        range: [3303, 3304],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      });
      expect(again.pgids).toEqual([42]);

      await releasePortLease({ registryFile, lockDir, worktreeId: '/wt/b', lockOpts: LOCK_OPTS });

      const raw = JSON.parse(await readFile(registryFile, 'utf-8'));
      expect(raw.leases).toHaveLength(1);
      expect(raw.leases[0].worktreeId).toBe('/wt/a');
      expect(raw.leases[0].pgids).toEqual([42]);
    });
  });
});

describe('acquirePortLease onPortConflict', () => {
  it('fires for a busy unleased port and still leases the next free port', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');
      const conflicts: number[] = [];

      const lease = await acquirePortLease({
        registryFile,
        lockDir,
        worktreeId: '/wt/a',
        branch: 'a',
        range: [3400, 3402],
        isPortFree: async (p) => p !== 3400,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
        onPortConflict: (p) => conflicts.push(p),
      });

      expect(conflicts).toEqual([3400]);
      expect(lease.port).toBe(3401);
    });
  });
});
