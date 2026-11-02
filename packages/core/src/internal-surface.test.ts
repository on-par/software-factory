import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as internalApi from './internal.js';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SRC_DIR, '../../..');
const INTERNAL_ENTRY = join(SRC_DIR, 'internal.ts');
const ALLOWLIST_FILE = join(SRC_DIR, 'internal-surface-allowlist.json');
const INTERNAL_SPECIFIER = '@on-par/factory-core/internal';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.factory', '.git', 'build', 'out']);
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs)$/;

const DECLARATION_PATTERNS = [
  /^export\s+(?:declare\s+)?(?:async\s+)?function\*?\s+(\w+)/gm,
  /^export\s+(?:declare\s+)?(?:abstract\s+)?class\s+(\w+)/gm,
  /^export\s+(?:declare\s+)?(?:const|let|var)\s+(\w+)/gm,
  /^export\s+(?:declare\s+)?(?:type|interface)\s+(\w+)/gm,
  /^export\s+(?:declare\s+)?(?:const\s+)?enum\s+(\w+)/gm,
];

function readIfExists(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

function listNames(body: string): string[] {
  return body
    .split(',')
    .map((item) => item.replace(/\/\/.*$/gm, '').trim())
    .filter((item) => item.length > 0);
}

function resolveReexport(fromFile: string, specifier: string, has: (f: string) => boolean): string {
  const base = resolve(dirname(fromFile), specifier);
  const direct = base.replace(/\.js$/, '.ts');
  if (has(direct)) return direct;
  const index = join(base.replace(/\.js$/, ''), 'index.ts');
  if (has(index)) return index;
  throw new Error(`${fromFile}: cannot resolve re-export '${specifier}' (tried ${direct}, ${index})`);
}

function collectInternalExports(
  entryFile: string,
  readSource: (file: string) => string | undefined = readIfExists,
): Set<string> {
  const names = new Set<string>();
  const visited = new Set<string>();
  const has = (f: string): boolean => readSource(f) !== undefined;
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = readSource(file) ?? '';
    for (const m of source.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
      for (const raw of listNames(m[1] ?? '')) {
        const item = raw.replace(/^type\s+/, '');
        const name = item.includes(' as ') ? (item.split(/\s+as\s+/).pop() ?? '') : item;
        if (name !== '' && name !== 'default') names.add(name);
      }
    }
    for (const m of source.matchAll(/^export\s+\*\s+as\s+(\w+)\s+from/gm)) {
      if (m[1]) names.add(m[1]);
    }
    for (const m of source.matchAll(/^export\s+\*\s+from\s+['"](\.[^'"]+)['"]/gm)) {
      if (m[1]) visit(resolveReexport(file, m[1], has));
    }
    for (const pattern of DECLARATION_PATTERNS) {
      for (const m of source.matchAll(pattern)) {
        if (m[1]) names.add(m[1]);
      }
    }
  };
  visit(entryFile);
  return names;
}

function parseImportedInternalNames(source: string, file: string): string[] {
  const spec = INTERNAL_SPECIFIER;
  const unattributable = [
    new RegExp(`import\\s+\\*\\s+as\\s+\\w+\\s+from\\s*['"]${spec}['"]`),
    new RegExp(`import\\s+\\w+\\s*(?:,|from)\\s*['"]${spec}`),
    new RegExp(`import\\(\\s*['"]${spec}['"]\\s*\\)`),
  ];
  if (unattributable.some((re) => re.test(source))) {
    throw new Error(`${file}: namespace/dynamic import of ${spec} can't be attributed to names; import named bindings`);
  }
  const names: string[] = [];
  const named = new RegExp(`(?:import|export)\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*['"]${spec}['"]`, 'g');
  for (const m of source.matchAll(named)) {
    for (const raw of listNames(m[1] ?? '')) {
      const original = raw.replace(/^type\s+/, '').split(/\s+as\s+/)[0] ?? '';
      if (original !== '') names.push(original);
    }
  }
  return names;
}

function walk(dir: string, visitFile: (file: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, visitFile);
    } else if (SOURCE_EXT.test(entry.name)) {
      visitFile(full);
    }
  }
}

function collectConsumerImports(repoRoot: string): Set<string> {
  const packagesDir = join(repoRoot, 'packages');
  const packageRoots = existsSync(packagesDir)
    ? readdirSync(packagesDir)
        .filter((name) => name !== 'core')
        .map((name) => join(packagesDir, name))
    : [];
  const roots = [...packageRoots, ...['scripts', 'src', 'tests'].map((d) => join(repoRoot, d))].filter(
    (d) => existsSync(d) && statSync(d).isDirectory(),
  );
  const imported = new Set<string>();
  for (const root of roots) {
    walk(root, (file) => {
      const source = readFileSync(file, 'utf8');
      if (!source.includes(INTERNAL_SPECIFIER)) return;
      for (const name of parseImportedInternalNames(source, file)) imported.add(name);
    });
  }
  return imported;
}

interface SurfaceDiff {
  extra: string[];
  staleImported: string[];
  staleMissing: string[];
  duplicates: string[];
}

function diffSurface(input: {
  exported: ReadonlySet<string>;
  imported: ReadonlySet<string>;
  allowlist: readonly string[];
}): SurfaceDiff {
  const { exported, imported, allowlist } = input;
  const listed = new Set(allowlist);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of allowlist) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return {
    extra: [...exported].filter((n) => !imported.has(n) && !listed.has(n)).sort(),
    staleImported: [...listed].filter((n) => imported.has(n)).sort(),
    staleMissing: [...listed].filter((n) => !exported.has(n)).sort(),
    duplicates: [...duplicates].sort(),
  };
}

describe('internal.ts export surface guard (#3779)', () => {
  it('collects named, type, aliased and re-exported imports of the internal entry', () => {
    const source = `
import {
  a,
  type B,
  c as d,
} from '@on-par/factory-core/internal';
import type { E } from '@on-par/factory-core/internal';
export { f } from '@on-par/factory-core/internal';
import { other } from '@on-par/factory-core';
`;
    expect(parseImportedInternalNames(source, 'x.ts').sort()).toEqual(['B', 'E', 'a', 'c', 'f']);
    expect(() => parseImportedInternalNames(`import * as ns from '@on-par/factory-core/internal';`, 'y.ts')).toThrow(
      /namespace\/dynamic import/,
    );
  });

  it('collects value and type exports through export * chains', () => {
    const files = new Map<string, string>([
      [
        '/x/internal.ts',
        [`export { a, type B } from './y.js';`, `export * from './z.js';`, `export * as ns from './w.js';`].join('\n'),
      ],
      [
        '/x/z.ts',
        ['export function zf() {}', 'export interface ZI {}', 'export const zc = 1;', 'export type ZT = string;'].join(
          '\n',
        ),
      ],
    ]);
    const exported = collectInternalExports('/x/internal.ts', (f) => files.get(f));
    expect([...exported].sort()).toEqual(['B', 'ZI', 'ZT', 'a', 'ns', 'zc', 'zf']);
    files.set('/x/internal.ts', `export * from './missing.js';`);
    expect(() => collectInternalExports('/x/internal.ts', (f) => files.get(f))).toThrow(/cannot resolve re-export/);
  });

  it('names an export that is neither imported nor allowlisted', () => {
    const diff = diffSurface({
      exported: new Set(['a', 'b', 'c']),
      imported: new Set(['a']),
      allowlist: ['b'],
    });
    expect(diff.extra).toEqual(['c']);
  });

  it('names an allowlist entry that a consumer now imports', () => {
    const diff = diffSurface({
      exported: new Set(['a']),
      imported: new Set(['a']),
      allowlist: ['a'],
    });
    expect(diff.staleImported).toEqual(['a']);
  });

  it('names an allowlist entry that internal.ts no longer exports', () => {
    const diff = diffSurface({
      exported: new Set(['a']),
      imported: new Set(['a']),
      allowlist: ['gone'],
    });
    expect(diff.staleMissing).toEqual(['gone']);
  });

  it('the consumer scan finds names imported by cli, tui, grade and scripts', () => {
    const imported = collectConsumerImports(REPO_ROOT);
    expect(imported.has('classifyFailure')).toBe(true);
    expect(imported.has('runUnpark')).toBe(true);
    expect(imported.size).toBeGreaterThan(300);
  });

  it('the parsed export set covers every runtime export of internal.ts', () => {
    const parsed = collectInternalExports(INTERNAL_ENTRY);
    const missing = Object.keys(internalApi).filter((k) => !parsed.has(k));
    expect(missing, `export names the parser missed: ${missing.join(', ')}`).toEqual([]);
  });

  it('the allowlist is sorted and has no duplicates', () => {
    const json: string[] = JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8'));
    expect(json).toEqual([...new Set(json)].sort());
  });

  it('internal.ts exports exactly the consumer-imported names plus the frozen allowlist', () => {
    const allowlist: string[] = JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8'));
    const diff = diffSurface({
      exported: collectInternalExports(INTERNAL_ENTRY),
      imported: collectConsumerImports(REPO_ROOT),
      allowlist,
    });
    expect(
      diff.extra,
      'internal.ts exports names no consumer imports; import them or remove the export (or, for a deliberate addition, add to internal-surface-allowlist.json)',
    ).toEqual([]);
    expect(
      diff.staleImported,
      'allowlist entries now imported by a consumer — remove them from internal-surface-allowlist.json',
    ).toEqual([]);
    expect(diff.staleMissing, 'allowlist entries internal.ts no longer exports — remove them').toEqual([]);
    expect(diff.duplicates, 'allowlist has duplicate entries').toEqual([]);
  });
});
