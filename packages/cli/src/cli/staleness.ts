// packages/cli/src/cli/staleness.ts — refuse to run from a dist/ older than src/

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface StalenessDeps {
  exists: (p: string) => boolean;
  readFile: (p: string) => string;
  /** Absolute paths of all files under dir, recursive. */
  listFiles: (dir: string) => string[];
  mtimeMs: (p: string) => number;
}

export function defaultStalenessDeps(): StalenessDeps {
  return {
    exists: (p) => existsSync(p),
    readFile: (p) => readFileSync(p, 'utf-8'),
    listFiles: (dir) => {
      const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
    },
    mtimeMs: (p) => statSync(p).mtimeMs,
  };
}

const RUNTIME_PACKAGES = ['config', 'core', 'tui', 'cli'];

export function findWorkspaceRoot(startDir: string, deps: StalenessDeps): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const pkgJsonPath = join(dir, 'package.json');
    if (deps.exists(pkgJsonPath)) {
      try {
        const parsed = JSON.parse(deps.readFile(pkgJsonPath)) as { workspaces?: unknown };
        if (parsed.workspaces !== undefined) return dir;
      } catch {
        // malformed package.json — not a match, keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface PackageStaleness {
  pkg: string;
  stale: boolean;
  reason: string;
}

function isComparableSrcFile(path: string): boolean {
  return (path.endsWith('.ts') || path.endsWith('.tsx')) && !path.includes('.test.');
}

function newestMtime(files: string[], deps: StalenessDeps): number {
  let newest = -Infinity;
  for (const f of files) {
    const mtime = deps.mtimeMs(f);
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

export function checkDistFreshness(rootDir: string, deps: StalenessDeps): PackageStaleness[] {
  const results: PackageStaleness[] = [];

  for (const pkg of RUNTIME_PACKAGES) {
    const srcDir = join(rootDir, 'packages', pkg, 'src');
    const distDir = join(rootDir, 'packages', pkg, 'dist');

    if (!deps.exists(srcDir)) continue;

    const srcFiles = deps.listFiles(srcDir).filter(isComparableSrcFile);
    if (srcFiles.length === 0) continue;

    const newestSrc = newestMtime(srcFiles, deps);

    if (!deps.exists(distDir)) {
      results.push({ pkg, stale: true, reason: `${pkg}: dist/ missing` });
      continue;
    }

    const distFiles = deps.listFiles(distDir);
    if (distFiles.length === 0) {
      results.push({ pkg, stale: true, reason: `${pkg}: dist/ empty` });
      continue;
    }

    const newestDist = newestMtime(distFiles, deps);

    if (newestSrc > newestDist) {
      results.push({
        pkg,
        stale: true,
        reason: `${pkg}: src is ${new Date(newestSrc).toISOString()} but dist is ${new Date(newestDist).toISOString()}`,
      });
    } else {
      results.push({ pkg, stale: false, reason: `${pkg}: dist newer than src` });
    }
  }

  return results;
}

export function formatStaleDistMessage(stale: PackageStaleness[], rootDir: string): string {
  const lines = ['factory: compiled dist is stale — refusing to run old code'];
  for (const s of stale) {
    lines.push(`  - ${s.reason}`);
  }
  lines.push(`fix: run 'npm run build' in ${rootDir}`);
  lines.push('override: FACTORY_ALLOW_STALE=1 (runs anyway, at your own risk)');
  return lines.join('\n');
}

const BYPASS_COMMANDS = new Set(['doctor', '--help', '-h', '--version', '-V']);

export interface StalenessGuardOpts {
  entryUrl: string;
  env: NodeJS.ProcessEnv;
  argv: string[];
  error: (msg: string) => void;
  warn: (msg: string) => void;
  deps?: StalenessDeps;
}

export function runStalenessGuard(opts: StalenessGuardOpts): number | null {
  const deps = opts.deps ?? defaultStalenessDeps();
  const entryPath = fileURLToPath(opts.entryUrl);
  if (!entryPath.split(sep).includes('dist')) return null;

  const root = findWorkspaceRoot(dirname(entryPath), deps);
  if (root === undefined) return null;

  const stale = checkDistFreshness(root, deps).filter((p) => p.stale);
  if (stale.length === 0) return null;

  const message = formatStaleDistMessage(stale, root);

  if (opts.env.FACTORY_ALLOW_STALE === '1') {
    opts.warn(`factory: FACTORY_ALLOW_STALE=1 — running stale dist:\n${message}`);
    return null;
  }

  if (opts.argv[2] !== undefined && BYPASS_COMMANDS.has(opts.argv[2])) {
    opts.warn(message);
    return null;
  }

  opts.error(message);
  return 2;
}

export function distFreshnessProbe(
  entryUrl: string,
  deps: StalenessDeps = defaultStalenessDeps(),
): (() => { fresh: boolean; detail: string }) | undefined {
  const entryPath = fileURLToPath(entryUrl);
  if (!entryPath.split(sep).includes('dist')) return undefined;

  const root = findWorkspaceRoot(dirname(entryPath), deps);
  if (root === undefined) return undefined;

  return () => {
    const results = checkDistFreshness(root, deps);
    const stale = results.filter((r) => r.stale);
    if (stale.length === 0) {
      return { fresh: true, detail: 'dist newer than src' };
    }
    return { fresh: false, detail: stale.map((s) => s.reason).join('; ') };
  };
}
