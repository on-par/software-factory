import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkPackageDir,
  checkPackFiles,
  parsePackJson,
  parseWorkspaceList,
  runPackHygiene,
  verifyPack,
} from './pack-hygiene.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'scripts', 'pack-hygiene-cli.ts');
const PUBLISH_LIST = join(ROOT, 'scripts', 'publish-workspaces.txt');
const CLEAN = ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts'];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pack-hygiene-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePackage(opts: { dist: boolean; docs?: boolean }): void {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: '@on-par/pack-fixture',
      version: '0.0.0',
      files: ['dist', '!dist/.tsbuildinfo'],
      scripts: { prepack: `node ${JSON.stringify(CLI)} prepack` },
    }),
  );
  if (opts.docs !== false) {
    writeFileSync(join(dir, 'README.md'), '# fixture\n');
    writeFileSync(join(dir, 'LICENSE'), 'MIT\n');
  }
  if (opts.dist) {
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'index.js'), 'export {};\n');
    writeFileSync(join(dir, 'dist', 'index.test.js'), '');
    writeFileSync(join(dir, 'dist', '.tsbuildinfo'), '{}');
  }
}

function io(files: Record<string, string> = {}) {
  const errors: string[] = [];
  return {
    errors,
    io: { cwd: dir, readFile: (path: string) => files[path] ?? '', err: (text: string) => errors.push(text) },
  };
}

describe('checkPackFiles', () => {
  it('accepts a tarball with package.json, README, LICENSE and dist/ only', () => {
    expect(checkPackFiles('@on-par/x', CLEAN)).toEqual([]);
  });

  it('reports each missing required file and an empty dist/', () => {
    expect(checkPackFiles('@on-par/x', ['package.json'])).toEqual([
      '@on-par/x: tarball is missing README.md',
      '@on-par/x: tarball is missing LICENSE',
      '@on-par/x: tarball has no dist/ files (not built?)',
    ]);
  });

  it('rejects test files, test-support kits, build info and anything outside dist/', () => {
    const files = [
      ...CLEAN,
      'dist/index.test.js',
      'src/defaults.test.ts',
      'dist/test-support/index.js',
      'dist/.tsbuildinfo',
      'src/index.ts',
    ];
    expect(checkPackFiles('@on-par/x', files)).toEqual([
      '@on-par/x: tarball ships test file dist/index.test.js',
      '@on-par/x: tarball ships test file src/defaults.test.ts',
      '@on-par/x: tarball ships test-support file dist/test-support/index.js',
      '@on-par/x: tarball ships tsc build info dist/.tsbuildinfo',
      '@on-par/x: tarball ships src/index.ts from outside dist/',
    ]);
  });

  it('does not mistake a name that merely contains "test" for a test file', () => {
    expect(checkPackFiles('@on-par/x', [...CLEAN, 'dist/testing.js', 'dist/latest.js'])).toEqual([]);
  });

  it('allows only direct schema artifacts in the CLI package', () => {
    expect(checkPackFiles('@on-par/factory-cli', [...CLEAN, 'schemas/status.schema.json'])).toEqual([]);
    const rejected = [
      ['schemas/nested/status.schema.json', 'tarball ships schemas/nested/status.schema.json from outside dist/'],
      ['schemas/../status.schema.json', 'tarball ships schemas/../status.schema.json from outside dist/'],
      ['schemas/README.json', 'tarball ships schemas/README.json from outside dist/'],
      ['schemas/status.test.schema.json', 'tarball ships test file schemas/status.test.schema.json'],
      ['schemas/test-support/helper.js', 'tarball ships test-support file schemas/test-support/helper.js'],
      ['schemas/.tsbuildinfo', 'tarball ships tsc build info schemas/.tsbuildinfo'],
      ['schemas//status.schema.json', 'tarball ships schemas//status.schema.json from outside dist/'],
    ] as const;
    for (const [path, problem] of rejected) {
      expect(checkPackFiles('@on-par/factory-cli', [...CLEAN, path])).toContain(`@on-par/factory-cli: ${problem}`);
    }
    expect(checkPackFiles('@on-par/other', [...CLEAN, 'schemas/status.schema.json'])).toContain(
      '@on-par/other: tarball ships schemas/status.schema.json from outside dist/',
    );
  });
});

describe('checkPackageDir', () => {
  it('passes a built package with README and LICENSE', () => {
    writePackage({ dist: true });
    expect(checkPackageDir(dir)).toEqual([]);
  });

  it('fails when dist/ is missing', () => {
    writePackage({ dist: false });
    expect(checkPackageDir(dir)).toEqual([
      `${join(dir, 'dist')} is missing or empty; run \`npm run build\` at the repo root before packing`,
    ]);
  });

  it('fails when dist/ exists but is empty, and when README/LICENSE are missing', () => {
    writePackage({ dist: false, docs: false });
    mkdirSync(join(dir, 'dist'));
    expect(checkPackageDir(dir)).toEqual([
      `${join(dir, 'dist')} is missing or empty; run \`npm run build\` at the repo root before packing`,
      `${join(dir, 'README.md')} is missing`,
      `${join(dir, 'LICENSE')} is missing`,
    ]);
  });
});

describe('parsePackJson', () => {
  it('extracts name and file paths', () => {
    const text = JSON.stringify([{ name: '@on-par/x', version: '1.0.0', files: [{ path: 'a' }, { path: 'b' }] }]);
    expect(parsePackJson(text)).toEqual([{ name: '@on-par/x', files: ['a', 'b'] }]);
  });

  it('rejects output that is not an array', () => {
    expect(() => parsePackJson('{}')).toThrow('npm pack --json output is not an array');
  });

  it('rejects entries without a name or a files array', () => {
    expect(() => parsePackJson('[null]')).toThrow('npm pack --json entry is missing name or files');
    expect(() => parsePackJson('[{"name":"x"}]')).toThrow('npm pack --json entry is missing name or files');
  });
});

describe('parseWorkspaceList', () => {
  it('trims lines and drops blanks, CRLF included', () => {
    expect(parseWorkspaceList(' @on-par/a \r\n\r\n@on-par/b\n')).toEqual(['@on-par/a', '@on-par/b']);
  });
});

describe('verifyPack', () => {
  it('reports listed packages absent from the pack and problems in packed ones', () => {
    const entries = [
      { name: '@on-par/a', files: CLEAN },
      { name: '@on-par/b', files: [...CLEAN, 'src/x.ts'] },
    ];
    expect(verifyPack(entries, ['@on-par/a', '@on-par/b', '@on-par/c'])).toEqual([
      '@on-par/c: not in the pack output',
      '@on-par/b: tarball ships src/x.ts from outside dist/',
    ]);
  });
});

describe('runPackHygiene', () => {
  it('prepack exits 0 for a built package and 1 with reasons otherwise', () => {
    writePackage({ dist: true });
    expect(runPackHygiene(['prepack'], io().io)).toBe(0);
    rmSync(join(dir, 'dist'), { recursive: true });
    const t = io();
    expect(runPackHygiene(['prepack'], t.io)).toBe(1);
    expect(t.errors.join('')).toContain('pack-hygiene: ');
    expect(t.errors.join('')).toContain('is missing or empty');
  });

  it('verify reads the pack JSON and the publish list', () => {
    const pack = JSON.stringify([{ name: '@on-par/a', files: CLEAN.map((path) => ({ path })) }]);
    expect(runPackHygiene(['verify', 'p.json', 'l.txt'], io({ 'p.json': pack, 'l.txt': '@on-par/a\n' }).io)).toBe(0);
    const t = io({ 'p.json': pack, 'l.txt': '@on-par/a\n@on-par/b\n' });
    expect(runPackHygiene(['verify', 'p.json', 'l.txt'], t.io)).toBe(1);
    expect(t.errors).toEqual(['pack-hygiene: @on-par/b: not in the pack output\n']);
  });

  it('prints usage and exits 2 on unknown or malformed commands', () => {
    for (const argv of [[], ['nope'], ['prepack', 'extra'], ['verify', 'only-one']]) {
      const t = io();
      expect(runPackHygiene(argv, t.io)).toBe(2);
      expect(t.errors[0]).toMatch(/^usage: pack-hygiene\.ts/);
    }
  });
});

describe('npm pack end to end', () => {
  function pack(cwd: string) {
    return spawnSync('npm', ['pack', '--json', '--pack-destination', dir], { cwd, encoding: 'utf8' });
  }

  it('a pack without a build fails in prepack; after a build it packs dist/ minus build info', () => {
    writePackage({ dist: false });
    const unbuilt = pack(dir);
    expect(unbuilt.status).not.toBe(0);
    expect(unbuilt.stderr).toContain('is missing or empty; run `npm run build`');

    writePackage({ dist: true });
    rmSync(join(dir, 'dist', 'index.test.js'));
    const built = pack(dir);
    expect(built.status).toBe(0);
    const [entry] = parsePackJson(built.stdout);
    expect(entry?.files.sort()).toEqual(['LICENSE', 'README.md', 'dist/index.js', 'package.json']);
  });

  it('every published workspace packs README, LICENSE and a clean dist/ (needs `npm run build`)', () => {
    const names = parseWorkspaceList(readFileSync(PUBLISH_LIST, 'utf8'));
    const out = execFileSync(
      'npm',
      ['pack', '--dry-run', '--json', '--ignore-scripts', ...names.flatMap((n) => ['--workspace', n])],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(verifyPack(parsePackJson(out), names)).toEqual([]);
  });

  it('every published workspace packs a package.json with engines.node >=24.0.0', () => {
    const names = parseWorkspaceList(readFileSync(PUBLISH_LIST, 'utf8'));
    const out = execFileSync(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', dir, ...names.flatMap((n) => ['--workspace', n])],
      { cwd: ROOT, encoding: 'utf8' },
    );
    const packed = JSON.parse(out) as { name: string; filename: string }[];
    expect(packed.map((p) => p.name).sort()).toEqual([...names].sort());
    for (const { name, filename } of packed) {
      const manifest = JSON.parse(
        execFileSync('tar', ['-xzOf', join(dir, basename(filename)), 'package/package.json'], { encoding: 'utf8' }),
      ) as { engines?: { node?: string } };
      expect(manifest.engines?.node, `${name} packed package.json engines.node`).toBe('>=24.0.0');
    }
  });

  it("every published package's LICENSE matches the repo root LICENSE", () => {
    const rootLicense = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
    for (const pkg of ['adr-kit', 'contracts', 'repo-context', 'config', 'core', 'tui', 'cli']) {
      expect(readFileSync(join(ROOT, 'packages', pkg, 'LICENSE'), 'utf8'), pkg).toBe(rootLicense);
    }
  });
});
