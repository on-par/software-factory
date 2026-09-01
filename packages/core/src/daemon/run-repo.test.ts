import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RepoRegistryListing } from './registry.js';
import { runDaemonRepo } from './run-repo.js';
import type { DaemonLaneContext } from './lane-context.js';

const tmpDirs: string[] = [];

async function tmpDir(prefix = 'run-repo-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runDaemonRepo', () => {
  it('dispatches to the external state root and leaves the checkout clean', async () => {
    const checkout = await tmpDir();
    const stateRoot = await tmpDir();
    const entry: RepoRegistryListing = {
      slug: 'on-par/alpha',
      path: checkout,
      attachedAt: '2026-08-25T12:00:00.000Z',
      state: 'active',
      stateRoot,
    };

    let captured: DaemonLaneContext | undefined;
    const orchestrate = async (context: DaemonLaneContext): Promise<void> => {
      captured = context;
      await mkdir(context.paths.plans, { recursive: true });
      await writeFile(join(context.paths.plans, 'issue-1.md'), 'x');
    };

    const returned = await runDaemonRepo(entry, orchestrate);

    expect(captured?.paths.root).toBe(resolve(stateRoot));
    expect(captured?.repoRoot).toBe(checkout);
    expect(returned).toBe(captured);
    expect(existsSync(join(checkout, '.factory'))).toBe(false);
    expect(existsSync(join(resolve(stateRoot), 'state', 'plans', 'issue-1.md'))).toBe(true);
  });

  it('falls back to the checkout-local .factory dir when no stateRoot is registered', async () => {
    const checkout = await tmpDir();
    const entry: RepoRegistryListing = {
      slug: 'on-par/beta',
      path: checkout,
      attachedAt: '2026-08-25T12:00:00.000Z',
      state: 'active',
    };

    let captured: DaemonLaneContext | undefined;
    const orchestrate = async (context: DaemonLaneContext): Promise<void> => {
      captured = context;
    };

    await runDaemonRepo(entry, orchestrate);

    expect(captured?.paths.root).toBe(resolve(checkout, '.factory'));
    expect(captured?.repoRoot).toBe(checkout);
  });
});
