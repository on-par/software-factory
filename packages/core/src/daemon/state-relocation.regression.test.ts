// src/daemon/state-relocation.regression.test.ts — Pins the checkout-vs-external
// state-path contract at both layers it flows through: getFactoryPaths (the path
// primitive) and createDaemonLaneContext (the daemon wiring). Guards against a
// future edit silently reintroducing in-checkout writes for daemon-managed repos,
// or breaking the checkout-local default that standalone (no-daemon) runs rely on.

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getFactoryPaths } from '../config/index.js';
import { createDaemonLaneContext } from './lane-context.js';
import type { RepoRegistryListing } from './registry.js';

// The daemon supplies an external state root in the format ~/.factory/<owner>/<name>/
// (registry.json is keyed by the same owner/name slug). Documented here as a fixture so
// this suite pins the intended external-root shape, not an arbitrary directory.
const OWNER = 'on-par';
const NAME = 'software-factory';
const externalStateRoot = join(homedir(), '.factory', OWNER, NAME); // ~/.factory/on-par/software-factory

// The orchestration-state fields the issue enumerates: config sits at `root`, the rest
// sit under `state`; the four *Lock fields cover "lock paths".
const ORCHESTRATION_STATE_FIELDS = [
  'queue',
  'config',
  'events',
  'costs',
  'plans',
  'reports',
  'breaker',
  'mergeLock',
  'gitLock',
  'runLock',
  'portsLock',
] as const;

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('state relocation regression: external state root vs. checkout default', () => {
  it('relocates every named orchestration-state field beneath an external state root, and none under the checkout', () => {
    const repoRoot = '/tmp/some-checkout';
    const paths = getFactoryPaths(repoRoot, externalStateRoot);
    const resolvedExternal = resolve(externalStateRoot);
    const resolvedCheckoutFactory = resolve(repoRoot, '.factory');

    for (const field of ORCHESTRATION_STATE_FIELDS) {
      expect(paths[field].startsWith(resolvedExternal)).toBe(true);
      expect(paths[field].startsWith(resolvedCheckoutFactory)).toBe(false);
    }

    // Guard fields added later: every value of the full return object must relocate too.
    for (const value of Object.values(paths)) {
      expect(value.startsWith(resolvedExternal)).toBe(true);
      expect(value.startsWith(resolvedCheckoutFactory)).toBe(false);
    }
  });

  it('relocates the named fields through the daemon wiring (createDaemonLaneContext) when the registry entry carries a stateRoot', () => {
    const repoRoot = '/tmp/some-checkout';
    const entry: RepoRegistryListing = {
      slug: `${OWNER}/${NAME}`,
      path: repoRoot,
      attachedAt: '2026-08-25T12:00:00.000Z',
      state: 'active',
      stateRoot: externalStateRoot,
    };

    const context = createDaemonLaneContext(entry);
    const resolvedExternal = resolve(externalStateRoot);
    const resolvedCheckoutFactory = resolve(repoRoot, '.factory');

    expect(context.repoRoot).toBe(repoRoot);
    for (const field of ORCHESTRATION_STATE_FIELDS) {
      expect(context.paths[field].startsWith(resolvedExternal)).toBe(true);
      expect(context.paths[field].startsWith(resolvedCheckoutFactory)).toBe(false);
    }
  });

  it('keeps every path field beneath <repoRoot>/.factory when no state root is given', () => {
    const repoRoot = '/tmp/some-checkout';
    const paths = getFactoryPaths(repoRoot);
    const resolvedCheckoutFactory = resolve(repoRoot, '.factory');

    for (const field of ORCHESTRATION_STATE_FIELDS) {
      expect(paths[field].startsWith(resolvedCheckoutFactory)).toBe(true);
    }
    for (const value of Object.values(paths)) {
      expect(value.startsWith(resolvedCheckoutFactory)).toBe(true);
    }

    expect(paths.config.startsWith(paths.root)).toBe(true);
    expect(paths.queue.startsWith(paths.state)).toBe(true);
  });

  it('a standalone run with no daemon involvement writes and reads an artifact under <repoRoot>/.factory', async () => {
    const repoRoot = await mktempTracked('factory-standalone-nodaemon-');

    // Exactly the standalone CLI code path: packages/cli/src/cli/index.ts calls
    // getFactoryPaths(repoRoot) with no state root.
    const paths = getFactoryPaths(repoRoot);

    expect(paths.root).toBe(resolve(repoRoot, '.factory'));

    await mkdir(paths.plans, { recursive: true });
    const planFile = join(paths.plans, 'issue-1042.md');
    await writeFile(planFile, '# Plan');
    const readBack = await readFile(planFile, 'utf-8');

    expect(readBack).toBe('# Plan');
    expect(planFile).toBe(resolve(repoRoot, '.factory', 'state', 'plans', 'issue-1042.md'));
    expect(existsSync(join(repoRoot, '.factory'))).toBe(true);
  });

  it('resolves paths beneath <repoRoot>/.factory for a legacy/standalone daemon registry entry with no stateRoot', () => {
    const repoRoot = '/tmp/some-checkout';
    const entry: RepoRegistryListing = {
      slug: `${OWNER}/${NAME}`,
      path: repoRoot,
      attachedAt: '2026-08-25T12:00:00.000Z',
      state: 'active',
    };

    const context = createDaemonLaneContext(entry);

    expect(context.paths.root).toBe(resolve(repoRoot, '.factory'));
  });
});

async function mktempTracked(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
