// src/checkers/probe.test.ts — Once-per-round worktree probing shared by the CHECK phase and checkers

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  countPlaceholderLinks,
  detectPythonTestSurface,
  fileExists,
  findHtmlFiles,
  type PackageJsonProbe,
  probeWorktree,
  type PythonTestSurface,
  type PythonTestSurfaceSource,
  type WorktreeProbe,
} from './index.js';

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

async function makeWorktree(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'checker-probe-test-'));
  tempDirs.add(dir);

  for (const [path, contents] of Object.entries(files)) {
    const fullPath = join(dir, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents);
  }

  return dir;
}

describe('probeWorktree', () => {
  it('captures package.json scripts, an ordered HTML walk, and Playwright config facts', async () => {
    const worktree = await makeWorktree({
      'package.json': JSON.stringify({
        scripts: { build: 'tsc', e2e: 'playwright test', lint: 42 },
        version: '1.0.0',
      }),
      'a.html': '<a href="https://example.com">ok</a>',
      'nested/b.html': '<a href="#">x</a>',
      'playwright.config.ts': 'export default { use: { headless: false } };\n',
      'coverage/skipped.html': '<a href="#">y</a>',
      'dist/index.html': '<a href="#">z</a>',
    });

    const probe: WorktreeProbe = await probeWorktree(worktree);
    const pkg: PackageJsonProbe = probe.packageJson;

    expect(pkg).toEqual({ status: 'loaded', value: expect.any(Object) });
    expect(probe.htmlFiles).toEqual(['a.html', 'nested/b.html']);
    expect(probe.playwrightConfigFiles).toEqual(['playwright.config.ts']);
    expect(probe.playwrightConfigContents).toEqual({
      'playwright.config.ts': 'export default { use: { headless: false } };\n',
    });
    expect(probe.scripts).toEqual({ build: 'tsc', e2e: 'playwright test' });
    expect(probe.pythonTestSurface).toEqual({ present: false, sources: [] });
  });

  it('carries the Python test-surface fact when config and convention surfaces exist', async () => {
    const worktree = await makeWorktree({
      'pyproject.toml': '[project]\nname = "x"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
      'tests/test_x.py': 'def test_x(): pass\n',
    });

    const probe = await probeWorktree(worktree);

    expect(probe.pythonTestSurface).toEqual({ present: true, sources: ['pyproject.toml', 'tests/'] });
  });

  it('reports absent package.json with no scripts', async () => {
    const worktree = await makeWorktree({ 'index.html': '<main>clean</main>' });

    const probe = await probeWorktree(worktree);

    expect(probe.packageJson).toEqual({ status: 'absent' });
    expect(probe.scripts).toEqual({});
  });

  it('reports an unreadable package.json (directory) with the recorded error', async () => {
    const worktree = await makeWorktree();
    await mkdir(join(worktree, 'package.json'));

    const probe = await probeWorktree(worktree);

    expect(probe.packageJson.status).toBe('unreadable');
    if (probe.packageJson.status === 'unreadable') {
      expect(probe.packageJson.error).toBeDefined();
    }
    expect(probe.scripts).toEqual({});
  });

  it('reports an unreadable package.json (parse error) and still walks HTML files', async () => {
    const worktree = await makeWorktree({ 'package.json': '{not json', 'a.html': '<main>clean</main>' });

    const probe = await probeWorktree(worktree);

    expect(probe.packageJson.status).toBe('unreadable');
    expect(probe.htmlFiles).toEqual(['a.html']);
    expect(probe.scripts).toEqual({});
  });

  it('detects the first existing Playwright config file in canonical order', async () => {
    const worktree = await makeWorktree({
      'playwright.config.js': 'export default {};\n',
      'playwright.config.ts': 'export default { use: { headless: false } };\n',
    });

    const probe = await probeWorktree(worktree);

    expect(probe.playwrightConfigFiles).toEqual(['playwright.config.ts', 'playwright.config.js']);
    expect(probe.playwrightConfigContents['playwright.config.ts']).toContain('headless: false');
    expect(probe.playwrightConfigContents['playwright.config.js']).toContain('export default');
  });
});

describe('detectPythonTestSurface', () => {
  it('detects a pyproject.toml with a [tool.pytest.ini_options] section', async () => {
    const worktree = await makeWorktree({
      'pyproject.toml': '[project]\nname = "x"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
    });

    expect(await detectPythonTestSurface(worktree)).toEqual({ present: true, sources: ['pyproject.toml'] });
  });

  it('ignores a pyproject.toml without the pytest section', async () => {
    const worktree = await makeWorktree({ 'pyproject.toml': '[project]\nname = "x"\n' });

    expect(await detectPythonTestSurface(worktree)).toEqual({ present: false, sources: [] });
  });

  it('detects pytest.ini by existence alone', async () => {
    const worktree = await makeWorktree({ 'pytest.ini': '[pytest]\n' });

    expect(await detectPythonTestSurface(worktree)).toEqual({ present: true, sources: ['pytest.ini'] });
  });

  it('detects a setup.cfg with a [tool:pytest] section but not one without it', async () => {
    const withSection = await makeWorktree({ 'setup.cfg': '[metadata]\nname = x\n\n[tool:pytest]\n' });
    const withoutSection = await makeWorktree({ 'setup.cfg': '[metadata]\nname = x\n' });

    expect(await detectPythonTestSurface(withSection)).toEqual({ present: true, sources: ['setup.cfg'] });
    expect(await detectPythonTestSurface(withoutSection)).toEqual({ present: false, sources: [] });
  });

  it('detects a tox.ini with a [pytest] section but not one without it', async () => {
    const withSection = await makeWorktree({ 'tox.ini': '[tox]\nenvlist = py312\n\n[pytest]\n' });
    const withoutSection = await makeWorktree({ 'tox.ini': '[tox]\nenvlist = py312\n' });

    expect(await detectPythonTestSurface(withSection)).toEqual({ present: true, sources: ['tox.ini'] });
    expect(await detectPythonTestSurface(withoutSection)).toEqual({ present: false, sources: [] });
  });

  it('detects a tests/ directory with test_*.py files, including nested ones', async () => {
    const flat = await makeWorktree({ 'tests/test_app.py': 'def test_x(): pass\n' });
    const nested = await makeWorktree({ 'tests/unit/test_deep.py': 'def test_y(): pass\n' });
    const noTests = await makeWorktree({ 'tests/helper.py': 'def helper(): pass\n' });

    expect(await detectPythonTestSurface(flat)).toEqual({ present: true, sources: ['tests/'] });
    expect(await detectPythonTestSurface(nested)).toEqual({ present: true, sources: ['tests/'] });
    expect(await detectPythonTestSurface(noTests)).toEqual({ present: false, sources: [] });
  });

  it('detects the ADR-0081-decided .factory/tests/ location as a Python test surface', async () => {
    const worktree = await makeWorktree({ '.factory/tests/test_x.py': 'def test_x(): pass\n' });

    const surface = await detectPythonTestSurface(worktree);

    expect(surface).toEqual({ present: true, sources: ['.factory/tests/'] });
  });

  it('detects top-level test_*.py files', async () => {
    const worktree = await makeWorktree({ 'test_main.py': 'def test_main(): pass\n' });

    expect(await detectPythonTestSurface(worktree)).toEqual({ present: true, sources: ['test_*.py'] });
  });

  it('reports multiple surfaces in canonical order', async () => {
    const worktree = await makeWorktree({
      'pyproject.toml': '[tool.pytest.ini_options]\n',
      'tests/test_a.py': 'def test_a(): pass\n',
    });

    const surface: PythonTestSurface = await detectPythonTestSurface(worktree);
    const expectedSources: PythonTestSurfaceSource[] = ['pyproject.toml', 'tests/'];
    expect(surface).toEqual({ present: true, sources: expectedSources });
  });

  it('reports no surface for a plain workspace', async () => {
    const worktree = await makeWorktree({ 'main.py': 'print(1)\n', 'README.md': '# x' });

    expect(await detectPythonTestSurface(worktree)).toEqual({ present: false, sources: [] });
  });

  it('skips generated and venv directories when walking tests/', async () => {
    const worktree = await makeWorktree({
      'tests/__pycache__/test_cached.py': 'def test_x(): pass\n',
      'tests/.venv/test_vendored.py': 'def test_y(): pass\n',
    });

    expect(await detectPythonTestSurface(worktree)).toEqual({ present: false, sources: [] });
  });
});

describe('countPlaceholderLinks', () => {
  it('returns 0 for empty and placeholder-free HTML', () => {
    expect(countPlaceholderLinks('')).toBe(0);
    expect(countPlaceholderLinks('<a href="https://example.com">ok</a>')).toBe(0);
  });

  it('counts placeholder links, including multiple on one line and across lines', () => {
    expect(countPlaceholderLinks('<a href="#">x</a>')).toBe(1);
    expect(countPlaceholderLinks('<a href="#">x</a>\n<a href="#">y</a>\n<a href="https://e.com">ok</a>')).toBe(2);
  });
});

describe('findHtmlFiles', () => {
  it('returns sorted relative paths, skipping generated-output directories', async () => {
    const worktree = await makeWorktree({
      'z.html': '<main>z</main>',
      'a/nested.html': '<main>nested</main>',
      'node_modules/lib.html': '<a href="#">x</a>',
      'coverage/report.html': '<a href="#">y</a>',
      'dist/out.html': '<a href="#">z</a>',
    });

    const files = await findHtmlFiles(worktree);

    expect(files).toEqual(['a/nested.html', 'z.html']);
  });

  it('returns an empty list for a worktree with no HTML files', async () => {
    const worktree = await makeWorktree({ 'index.ts': 'export {};' });

    expect(await findHtmlFiles(worktree)).toEqual([]);
  });
});

describe('fileExists', () => {
  it('returns true for an existing regular file', async () => {
    const worktree = await makeWorktree({ 'scripts/verify.sh': 'exit 0' });
    expect(await fileExists(join(worktree, 'scripts/verify.sh'))).toBe(true);
  });

  it('returns false for a missing path', async () => {
    const worktree = await makeWorktree();
    expect(await fileExists(join(worktree, 'no-such-file'))).toBe(false);
  });

  it('returns false for a directory', async () => {
    const worktree = await makeWorktree({ 'scripts/verify.sh': 'exit 0' });
    expect(await fileExists(join(worktree, 'scripts'))).toBe(false);
  });
});
