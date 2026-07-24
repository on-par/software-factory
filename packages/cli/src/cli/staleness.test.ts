import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  checkDistFreshness,
  defaultStalenessDeps,
  distFreshnessProbe,
  findWorkspaceRoot,
  formatStaleDistMessage,
  runStalenessGuard,
  type StalenessDeps,
} from './staleness.js';

/** Build a StalenessDeps from a map of path -> mtimeMs, plus optional file contents. */
function fakeDeps(mtimes: Record<string, number>, contents: Record<string, string> = {}): StalenessDeps {
  const paths = Object.keys(mtimes);
  return {
    exists: (p) => paths.some((f) => f === p || f.startsWith(p + '/')),
    readFile: (p) => {
      if (contents[p] !== undefined) return contents[p];
      throw new Error(`no fake content for ${p}`);
    },
    listFiles: (dir) => paths.filter((f) => f.startsWith(dir + '/')),
    mtimeMs: (p) => {
      if (mtimes[p] === undefined) throw new Error(`no fake mtime for ${p}`);
      return mtimes[p];
    },
  };
}

describe('findWorkspaceRoot', () => {
  it('finds the nearest ancestor package.json with a workspaces field', () => {
    const deps = fakeDeps(
      { '/repo/package.json': 1, '/repo/packages/cli/src/cli/index.ts': 1 },
      { '/repo/package.json': JSON.stringify({ workspaces: ['packages/*'] }) },
    );
    expect(findWorkspaceRoot('/repo/packages/cli/src/cli', deps)).toBe('/repo');
  });

  it('returns undefined when no ancestor has a workspaces field', () => {
    const deps = fakeDeps({ '/repo/package.json': 1 }, { '/repo/package.json': JSON.stringify({ name: 'x' }) });
    expect(findWorkspaceRoot('/repo/packages/cli/dist/cli', deps)).toBeUndefined();
  });

  it('skips a malformed package.json and keeps walking', () => {
    const deps = fakeDeps(
      { '/repo/package.json': 1, '/repo/packages/package.json': 1 },
      {
        '/repo/package.json': JSON.stringify({ workspaces: ['packages/*'] }),
        '/repo/packages/package.json': '{not json',
      },
    );
    expect(findWorkspaceRoot('/repo/packages/cli/src', deps)).toBe('/repo');
  });
});

const T0 = 1_000_000;
const T1 = 2_000_000;

function baseTree() {
  return {
    '/repo/package.json': T0,
    '/repo/packages/config/src/models.json': T0,
    '/repo/packages/config/dist/models.json': T1,
    '/repo/packages/core/src/phases/build.ts': T0,
    '/repo/packages/core/src/phases/build.test.ts': T0,
    '/repo/packages/core/dist/phases/build.js': T1,
    '/repo/packages/tui/src/app.ts': T0,
    '/repo/packages/tui/dist/app.js': T1,
    '/repo/packages/cli/src/cli/index.ts': T0,
    '/repo/packages/cli/dist/cli/index.js': T1,
  };
}

const baseContents = {
  '/repo/package.json': JSON.stringify({ workspaces: ['packages/*'] }),
};

describe('checkDistFreshness', () => {
  it('reports no stale packages when every dist is newer than its src', () => {
    const deps = fakeDeps(baseTree(), baseContents);
    const results = checkDistFreshness('/repo', deps);
    expect(results.some((r) => r.stale)).toBe(false);
  });

  it('reports exactly core stale when its src is newer, with both timestamps in the reason', () => {
    const tree = baseTree();
    tree['/repo/packages/core/src/phases/build.ts'] = T1 + 1000;
    const deps = fakeDeps(tree, baseContents);
    const results = checkDistFreshness('/repo', deps);
    const stale = results.filter((r) => r.stale);
    expect(stale.map((r) => r.pkg)).toEqual(['core']);
    expect(stale[0].reason).toContain(new Date(T1 + 1000).toISOString());
    expect(stale[0].reason).toContain(new Date(T1).toISOString());
  });

  it('ignores newer test files', () => {
    const tree = baseTree();
    tree['/repo/packages/core/src/phases/build.test.ts'] = T1 + 1000;
    const deps = fakeDeps(tree, baseContents);
    const results = checkDistFreshness('/repo', deps);
    expect(results.some((r) => r.stale)).toBe(false);
  });

  it('ignores newer non-TS src files', () => {
    const tree = baseTree();
    tree['/repo/packages/config/src/models.json'] = T1 + 1000;
    const deps = fakeDeps(tree, baseContents);
    const results = checkDistFreshness('/repo', deps);
    expect(results.some((r) => r.stale)).toBe(false);
  });

  it('reports missing dist as stale', () => {
    const tree = baseTree();
    delete (tree as Record<string, number>)['/repo/packages/tui/dist/app.js'];
    const deps = fakeDeps(tree, baseContents);
    const results = checkDistFreshness('/repo', deps);
    const tui = results.find((r) => r.pkg === 'tui');
    expect(tui?.stale).toBe(true);
    expect(tui?.reason).toContain('dist/ missing');
  });

  it('skips a package with no src dir entirely', () => {
    const tree = baseTree();
    delete (tree as Record<string, number>)['/repo/packages/tui/src/app.ts'];
    delete (tree as Record<string, number>)['/repo/packages/tui/dist/app.js'];
    const deps = fakeDeps(tree, baseContents);
    const results = checkDistFreshness('/repo', deps);
    expect(results.some((r) => r.pkg === 'tui')).toBe(false);
  });
});

describe('runStalenessGuard', () => {
  const error = vi.fn();
  const warn = vi.fn();

  it('returns null and touches no deps when entry is under src/', () => {
    error.mockClear();
    warn.mockClear();
    const deps: StalenessDeps = {
      exists: vi.fn(),
      readFile: vi.fn(),
      listFiles: vi.fn(),
      mtimeMs: vi.fn(),
    };
    const result = runStalenessGuard({
      entryUrl: 'file:///repo/packages/cli/src/cli/index.ts',
      env: {},
      argv: ['node', 'cli.js', 'run'],
      error,
      warn,
      deps,
    });
    expect(result).toBeNull();
    expect(deps.exists).not.toHaveBeenCalled();
  });

  it('returns null when entry is under dist/ but no workspace root exists above it', () => {
    const deps = fakeDeps({ '/nowhere/package.json': T0 }, { '/nowhere/package.json': JSON.stringify({}) });
    const result = runStalenessGuard({
      entryUrl: 'file:///nowhere/packages/cli/dist/cli/index.js',
      env: {},
      argv: ['node', 'cli.js', 'run'],
      error,
      warn,
      deps,
    });
    expect(result).toBeNull();
  });

  it('returns 2 and calls error with npm run build and stale package names when stale', () => {
    error.mockClear();
    warn.mockClear();
    const tree = baseTree();
    tree['/repo/packages/core/src/phases/build.ts'] = T1 + 1000;
    const deps = fakeDeps(tree, baseContents);
    const result = runStalenessGuard({
      entryUrl: 'file:///repo/packages/cli/dist/cli/index.js',
      env: {},
      argv: ['node', 'cli.js', 'run'],
      error,
      warn,
      deps,
    });
    expect(result).toBe(2);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('npm run build');
    expect(error.mock.calls[0][0]).toContain('core');
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns null and warns when FACTORY_ALLOW_STALE=1', () => {
    error.mockClear();
    warn.mockClear();
    const tree = baseTree();
    tree['/repo/packages/core/src/phases/build.ts'] = T1 + 1000;
    const deps = fakeDeps(tree, baseContents);
    const result = runStalenessGuard({
      entryUrl: 'file:///repo/packages/cli/dist/cli/index.js',
      env: { FACTORY_ALLOW_STALE: '1' },
      argv: ['node', 'cli.js', 'run'],
      error,
      warn,
      deps,
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('returns null and warns when argv[2] is doctor', () => {
    error.mockClear();
    warn.mockClear();
    const tree = baseTree();
    tree['/repo/packages/core/src/phases/build.ts'] = T1 + 1000;
    const deps = fakeDeps(tree, baseContents);
    const result = runStalenessGuard({
      entryUrl: 'file:///repo/packages/cli/dist/cli/index.js',
      env: {},
      argv: ['node', 'cli.js', 'doctor'],
      error,
      warn,
      deps,
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('returns null and warns when argv[2] is --version', () => {
    error.mockClear();
    warn.mockClear();
    const tree = baseTree();
    tree['/repo/packages/core/src/phases/build.ts'] = T1 + 1000;
    const deps = fakeDeps(tree, baseContents);
    const result = runStalenessGuard({
      entryUrl: 'file:///repo/packages/cli/dist/cli/index.js',
      env: {},
      argv: ['node', 'cli.js', '--version'],
      error,
      warn,
      deps,
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });
});

describe('distFreshnessProbe', () => {
  it('returns undefined for a src entryUrl', () => {
    const deps = fakeDeps(baseTree(), baseContents);
    expect(distFreshnessProbe('file:///repo/packages/cli/src/cli/index.ts', deps)).toBeUndefined();
  });

  it('reports fresh:false with the stale package name in detail over a stale tree', () => {
    const tree = baseTree();
    tree['/repo/packages/core/src/phases/build.ts'] = T1 + 1000;
    const deps = fakeDeps(tree, baseContents);
    const probe = distFreshnessProbe('file:///repo/packages/cli/dist/cli/index.js', deps);
    expect(probe).toBeDefined();
    const result = probe!();
    expect(result.fresh).toBe(false);
    expect(result.detail).toContain('core');
  });

  it('reports fresh:true over a fresh tree', () => {
    const deps = fakeDeps(baseTree(), baseContents);
    const probe = distFreshnessProbe('file:///repo/packages/cli/dist/cli/index.js', deps);
    expect(probe).toBeDefined();
    const result = probe!();
    expect(result.fresh).toBe(true);
  });
});

describe('defaultStalenessDeps', () => {
  it('wraps real fs calls', () => {
    const dir = mkdtempSync(join(tmpdir(), 'staleness-'));
    const filePath = join(dir, 'file.ts');
    writeFileSync(filePath, 'export {};');
    try {
      const deps = defaultStalenessDeps();
      expect(deps.exists(filePath)).toBe(true);
      expect(deps.exists(join(dir, 'missing.ts'))).toBe(false);
      expect(deps.readFile(filePath)).toBe('export {};');
      expect(deps.mtimeMs(filePath)).toBeGreaterThan(0);
      expect(deps.listFiles(dir)).toEqual([filePath]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('formatStaleDistMessage', () => {
  it('includes the fix and override lines', () => {
    const msg = formatStaleDistMessage([{ pkg: 'core', stale: true, reason: 'core: stale' }], '/repo');
    expect(msg).toContain("npm run build' in /repo");
    expect(msg).toContain('FACTORY_ALLOW_STALE=1');
    expect(msg).toContain('core: stale');
  });
});
