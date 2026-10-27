import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { acquirePortLease, readPortLeases } from './index.js';

const temps = createTempDirs();
afterEach(async () => {
  await temps.cleanup();
});

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const indexSpec = pathToFileURL(join(repoRoot, 'packages/core/src/environment/index.ts')).href;

function runChild(childPath: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', childPath, ...args], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

describe('ports.json across processes', () => {
  it('five processes leasing concurrently leave ports.json with five distinct ports', { timeout: 60_000 }, async () => {
    const dir = await temps.make('factory-ports-contention-');
    try {
      const registryFile = join(dir, 'ports.json');
      const lockDir = join(dir, 'ports.lock');
      const childPath = join(dir, 'child.mts');
      await writeFile(
        childPath,
        `import { acquirePortLease } from '${indexSpec}';
const [registryFile, lockDir, worktreeId] = process.argv.slice(2);
const lease = await acquirePortLease({
  registryFile, lockDir, worktreeId, branch: 'b', range: [41000, 41999],
  isPortFree: async () => true,
  probes: { isPidAlive: () => true, worktreeExists: () => true },
  lockOpts: { pollMs: 5 },
});
process.stdout.write(JSON.stringify(lease.port));
`,
      );
      const worktrees = await Promise.all(
        [1, 2, 3, 4, 5].map(async (n) => {
          const wt = join(dir, `wt${n}`);
          await mkdir(wt);
          return wt;
        }),
      );
      const results = await Promise.all(worktrees.map((wt) => runChild(childPath, [registryFile, lockDir, wt])));
      for (const r of results) expect(r, r.stderr).toMatchObject({ code: 0 });

      const printed = results.map((r) => JSON.parse(r.stdout) as number);
      const { leases } = JSON.parse(await readFile(registryFile, 'utf-8')) as {
        leases: { port: number; worktreeId: string }[];
      };
      expect(leases).toHaveLength(5);
      expect(new Set(leases.map((l) => l.port)).size).toBe(5);
      expect(new Set(leases.map((l) => l.worktreeId)).size).toBe(5);
      expect(leases.map((l) => l.port).sort()).toEqual([...printed].sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it(
    'a reader racing a writer process never sees an empty lease list while a lease exists',
    { timeout: 60_000 },
    async () => {
      const dir = await temps.make('factory-ports-race-');
      try {
        const registryFile = join(dir, 'ports.json');
        const lockDir = join(dir, 'ports.lock');
        const probes = { isPidAlive: () => true, worktreeExists: () => true };
        await acquirePortLease({
          registryFile,
          lockDir,
          worktreeId: '/wt/pinned',
          branch: 'pinned',
          range: [41000, 41999],
          isPortFree: async () => true,
          probes,
          lockOpts: { pollMs: 5 },
        });
        const childPath = join(dir, 'child.mts');
        await writeFile(
          childPath,
          `import { acquirePortLease, releasePortLease } from '${indexSpec}';
const [registryFile, lockDir] = process.argv.slice(2);
const probes = { isPidAlive: () => true, worktreeExists: () => true };
for (let i = 0; i < 300; i++) {
  await acquirePortLease({
    registryFile, lockDir, worktreeId: '/wt/churn', branch: 'churn', range: [41000, 41999],
    isPortFree: async () => true, probes, lockOpts: { pollMs: 5 },
  });
  await releasePortLease({ registryFile, lockDir, worktreeId: '/wt/churn', lockOpts: { pollMs: 5 } });
}
`,
        );
        let done = false;
        const child = runChild(childPath, [registryFile, lockDir]).finally(() => {
          done = true;
        });
        let reads = 0;
        let bad = 0;
        while (!done) {
          const leases = readPortLeases(registryFile);
          reads++;
          if (!leases.some((l) => l.worktreeId === '/wt/pinned')) bad++;
          await new Promise((resolve) => setImmediate(resolve));
        }
        const result = await child;
        expect(result, result.stderr).toMatchObject({ code: 0 });
        expect(reads).toBeGreaterThan(0);
        expect(bad).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
