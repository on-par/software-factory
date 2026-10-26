import { chmod, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { acquirePortLease, readPortLeases, releasePortLease } from './index.js';

const LOCK_OPTS = { pollMs: 5 };
const alwaysFree = async () => true;
const liveProbes = { isPidAlive: () => true, worktreeExists: () => true };

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ports-atomic-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('ports.json atomic write', () => {
  it('leaves no tmp files next to ports.json after lease and release', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');
      const base = {
        registryFile,
        lockDir,
        branch: 'b',
        range: [3100, 3999] as [number, number],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      };
      await acquirePortLease({ ...base, worktreeId: '/wt/a' });
      await acquirePortLease({ ...base, worktreeId: '/wt/b' });
      await releasePortLease({ registryFile, lockDir, worktreeId: '/wt/a', lockOpts: LOCK_OPTS });

      const entries = await readdir(dir);
      expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
      expect(entries).toContain('ports.json');
      expect(readPortLeases(registryFile)).toHaveLength(1);
    });
  });

  it.skipIf(process.getuid?.() === 0)('a failed write leaves the existing ports.json intact', async () => {
    await withTmpDir(async (dir) => {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'locks', 'ports.lock');
      const base = {
        registryFile,
        lockDir,
        branch: 'b',
        range: [3100, 3999] as [number, number],
        isPortFree: alwaysFree,
        probes: liveProbes,
        lockOpts: LOCK_OPTS,
      };
      await acquirePortLease({ ...base, worktreeId: '/wt/a' });
      const before = await readFile(registryFile, 'utf-8');
      await chmod(dir, 0o555);
      try {
        await expect(acquirePortLease({ ...base, worktreeId: '/wt/b' })).rejects.toThrow();
      } finally {
        await chmod(dir, 0o755);
      }
      expect(await readFile(registryFile, 'utf-8')).toBe(before);
      expect((await readdir(dir)).filter((e) => e.endsWith('.tmp'))).toEqual([]);
    });
  });
});
