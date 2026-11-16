import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

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

  it('reports an existing but empty dist dir as stale without throwing', () => {
    const tree = baseTree();
    delete (tree as Record<string, number>)['/repo/packages/tui/dist/app.js'];
    const base = fakeDeps(tree, baseContents);
    // dist dir exists (e.g. `mkdir -p` with a failed build) but contains zero files.
    const deps: StalenessDeps = {
      ...base,
      exists: (p) => p === '/repo/packages/tui/dist' || base.exists(p),
    };
    const results = checkDistFreshness('/repo', deps);
    const tui = results.find((r) => r.pkg === 'tui');
    expect(tui?.stale).toBe(true);
    expect(tui?.reason).toContain('dist/ empty');
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
  let errors: string[];
  let warns: string[];
  beforeEach(() => {
    errors = [];
    warns = [];
  });
  const error = (m: string) => void errors.push(m);
  const warn = (m: string) => void warns.push(m);
  const guard = (entryUrl: string, env: Record<string, string>, cmd: string, deps: StalenessDeps) =>
    runStalenessGuard({ entryUrl, env, argv: ['node', 'cli.js', cmd], error, warn, deps });

  it('returns null and touches no deps when entry is under src/', () => {
    const touched: string[] = [];
    const deps: StalenessDeps = {
      exists: () => (touched.push('exists'), false),
      readFile: () => (touched.push('readFile'), ''),
      listFiles: () => (touched.push('listFiles'), []),
      mtimeMs: () => (touched.push('mtimeMs'), 0),
    };
    const result = guard('file:///repo/packages/cli/src/cli/index.ts', {}, 'run', deps);
    expect(result).toBeNull();
    expect(touched).toEqual([]);
  });

  it('returns null when entry is under dist/ but no workspace root exists above it', () => {
    const deps = fakeDeps({ '/nowhere/package.json': T0 }, { '/nowhere/package.json': JSON.stringify({}) });
    const result = guard('file:///nowhere/packages/cli/dist/cli/index.js', {}, 'run', deps);
    expect(result).toBeNull();
  });

  it('returns 2 and calls error with npm run build and stale package names when stale', () => {
    const tree = baseTree();
    tree['/repo/packages/core/src/phases/build.ts'] = T1 + 1000;
    const deps = fakeDeps(tree, baseContents);
    const result = guard('file:///repo/packages/cli/dist/cli/index.js', {}, 'run', deps);
    expect(result).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('npm run build');
    expect(errors[0]).toContain('core');
    expect(warns).toEqual([]);
  });

  it('returns null and warns when FACTORY_ALLOW_STALE=1', () => {
    const tree = baseTree();
    tree['/repo/packages/core/src/phases/build.ts'] = T1 + 1000;
    const deps = fakeDeps(tree, baseContents);
    const result = guard('file:///repo/packages/cli/dist/cli/index.js', { FACTORY_ALLOW_STALE: '1' }, 'run', deps);
    expect(result).toBeNull();
    expect(warns).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('returns null and warns when argv[2] is doctor', () => {
    const tree = baseTree();
    tree['/repo/packages/core/src/phases/build.ts'] = T1 + 1000;
    const deps = fakeDeps(tree, baseContents);
    const result = guard('file:///repo/packages/cli/dist/cli/index.js', {}, 'doctor', deps);
    expect(result).toBeNull();
    expect(warns).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('returns null and warns when argv[2] is --version', () => {
    const tree = baseTree();
    tree['/repo/packages/core/src/phases/build.ts'] = T1 + 1000;
    const deps = fakeDeps(tree, baseContents);
    const result = guard('file:///repo/packages/cli/dist/cli/index.js', {}, '--version', deps);
    expect(result).toBeNull();
    expect(warns).toHaveLength(1);
    expect(errors).toEqual([]);
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
