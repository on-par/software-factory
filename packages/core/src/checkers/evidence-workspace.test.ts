import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirs } from '@on-par/factory-core/testing';
import {
  isWorkspaceTestFanOut,
  ownerWorkspace,
  resolveWorkspaceTestRunners,
  workspaceSelectorArgv,
  type WorkspaceTestRunner,
} from './evidence-workspace.js';

const tempDirs = createTempDirs();
afterEach(async () => {
  await tempDirs.cleanup();
});

async function repo(files: Record<string, unknown>): Promise<string> {
  const root = await tempDirs.make('evidence-workspace-');
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const pkg = (name: string, test: string) => ({ name, scripts: { test } });

describe('resolveWorkspaceTestRunners', () => {
  it('detects vitest in an npm workspace from the root fan-out script', async () => {
    const root = { scripts: { test: 'npm run test --workspaces --if-present' }, workspaces: ['apps/*'] };
    const dir = await repo({ 'package.json': root, 'apps/web/package.json': pkg('web', 'vitest run') });
    expect(await resolveWorkspaceTestRunners(dir, root)).toEqual([
      { dir: 'apps/web', name: 'web', runner: 'vitest', manager: 'npm' },
    ]);
  });

  it('detects jest in a pnpm workspace listed in pnpm-workspace.yaml', async () => {
    const root = { scripts: { test: 'pnpm -r test' } };
    const dir = await repo({
      'pnpm-workspace.yaml': 'packages:\n  - "libs/*"\n  - "!libs/skip"\n',
      'libs/a/package.json': pkg('a', 'jest --ci'),
    });
    expect(await resolveWorkspaceTestRunners(dir, root)).toEqual([
      { dir: 'libs/a', name: 'a', runner: 'jest', manager: 'pnpm' },
    ]);
  });

  it('detects vitest in a yarn workspace and keeps its package name', async () => {
    const root = { scripts: { test: 'yarn workspaces foreach -A run test' }, workspaces: { packages: ['pkgs/*'] } };
    const dir = await repo({
      'pkgs/a/package.json': pkg('@s/a', 'vitest'),
      'pkgs/b/package.json': { scripts: { test: 'vitest' } },
    });
    expect(await resolveWorkspaceTestRunners(dir, root)).toEqual([
      { dir: 'pkgs/a', name: '@s/a', runner: 'vitest', manager: 'yarn' },
    ]);
  });

  it('ignores workspaces whose test runner is not vitest or jest', async () => {
    const root = { scripts: { test: 'npm test --workspaces' }, workspaces: ['*/', '../x', '/abs'] };
    const dir = await repo({
      'a/package.json': pkg('a', 'mocha'),
      'b/package.json': pkg('b', 'pytest'),
      'c/package.json': '{bad json',
    });
    expect(await resolveWorkspaceTestRunners(dir, root)).toEqual([]);
  });

  it('returns no workspaces when the root test script does not fan out', async () => {
    const dir = await repo({ 'apps/web/package.json': pkg('web', 'vitest run') });
    for (const test of ['vitest run', 'turbo run test']) {
      expect(await resolveWorkspaceTestRunners(dir, { scripts: { test }, workspaces: ['apps/*'] })).toEqual([]);
    }
    expect(await resolveWorkspaceTestRunners(dir, null)).toEqual([]);
  });

  it('returns no workspaces on a malformed pnpm-workspace.yaml', async () => {
    const dir = await repo({ 'pnpm-workspace.yaml': 'packages: [unclosed', 'a/package.json': pkg('a', 'jest') });
    expect(await resolveWorkspaceTestRunners(dir, { scripts: { test: 'pnpm -r test' } })).toEqual([]);
  });
});

describe('isWorkspaceTestFanOut', () => {
  it('names the manager or null', () => {
    expect(isWorkspaceTestFanOut('npm test -ws')).toBe('npm');
    expect(isWorkspaceTestFanOut('pnpm --recursive test')).toBe('pnpm');
    expect(isWorkspaceTestFanOut('yarn workspaces run test')).toBe('yarn');
    expect(isWorkspaceTestFanOut('yarn workspaces foreach run build')).toBeNull();
    expect(isWorkspaceTestFanOut('bun run --filter "*" test')).toBeNull();
    expect(isWorkspaceTestFanOut('npm run "oops')).toBeNull();
  });
});

const web: WorkspaceTestRunner = { dir: 'apps/web', name: 'web', runner: 'vitest', manager: 'npm' };

describe('workspace selectors', () => {
  it('builds the npm exec workspace argv with a workspace-relative file and -t', () => {
    const owner = ownerWorkspace('apps/web/src/x.spec.ts', [web])!;
    expect(workspaceSelectorArgv(owner.workspace, { file: owner.relativeFile, names: ['does x'] })).toEqual([
      'npm',
      'exec',
      '--workspace',
      'apps/web',
      '--',
      'vitest',
      'run',
      'src/x.spec.ts',
      '-t',
      'does x',
    ]);
  });

  it('builds the pnpm and yarn workspace argv', () => {
    const selector = { file: 'a.test.ts', names: [] };
    expect(workspaceSelectorArgv({ ...web, manager: 'pnpm', runner: 'jest' }, selector)).toEqual([
      'pnpm',
      '--dir',
      'apps/web',
      'exec',
      'jest',
      'a.test.ts',
    ]);
    expect(workspaceSelectorArgv({ ...web, manager: 'yarn' }, selector)).toEqual([
      'yarn',
      'workspace',
      'web',
      'vitest',
      'run',
      'a.test.ts',
    ]);
  });

  it('picks the owning workspace by longest directory prefix', () => {
    const inner = { ...web, dir: 'apps/web/inner' };
    expect(ownerWorkspace('./apps/web/inner/a.test.ts', [web, inner])).toEqual({
      workspace: inner,
      relativeFile: 'a.test.ts',
    });
    expect(ownerWorkspace('apps/webx/a.test.ts', [web])).toBeNull();
  });
});
