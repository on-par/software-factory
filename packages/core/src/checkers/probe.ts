// src/checkers/probe.ts — Once-per-round worktree probing shared by the CHECK phase and every checker

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface PackageJson {
  scripts?: Record<string, string>;
  [k: string]: unknown;
}

/** The package.json tri-state made explicit: absent (ENOENT) vs unreadable (read/parse error, error recorded). */
export type PackageJsonProbe =
  { status: 'loaded'; value: PackageJson } | { status: 'absent' } | { status: 'unreadable'; error: unknown };

/** Where a Python test surface was found — config-declared names are the file, convention names the location. */
export type PythonTestSurfaceSource =
  'pyproject.toml' | 'pytest.ini' | 'setup.cfg' | 'tox.ini' | 'tests/' | '.factory/tests/' | 'test_*.py';

/** Probe-time fact: does this workspace have a pytest surface, and where (#1217). */
export interface PythonTestSurface {
  present: boolean;
  /** Every detected source, in canonical order (config-declared first, then convention). */
  sources: PythonTestSurfaceSource[];
}

export type LintConfigLinter = 'oxlint' | 'eslint' | 'biome';
/** 'executable' = TS/JS module the linter would evaluate; json/yaml are static data. */
export type LintConfigFormat = 'json' | 'yaml' | 'executable';

/** Probe-time fact: which linter the repo configures at its root, and where (#3039). */
export interface LintConfigProbe {
  linter: LintConfigLinter;
  /** Repo-relative config path (root-level filename). */
  configPath: string;
  format: LintConfigFormat;
  /** True for TS/JS configs: loading them runs code. The probe itself never loads them. */
  executable: boolean;
}

/** Facts captured exactly once per CHECK round — the single place worktree state is read. */
export interface WorktreeProbe {
  packageJson: PackageJsonProbe;
  /** Sorted relative `.html` list from findHtmlFiles (generated dirs skipped). */
  htmlFiles: string[];
  /** The subset of the standard Playwright config names that exist, in canonical order. */
  playwrightConfigFiles: string[];
  /** Existing config file contents, keyed by filename (unreadable files contribute ''). */
  playwrightConfigContents: Record<string, string>;
  /** String-valued entries of package.json.scripts (absent/unreadable package.json → {}). */
  scripts: Record<string, string>;
  /** Python (pytest) test-surface fact — config-declared and convention surfaces (#1217). */
  pythonTestSurface: PythonTestSurface;
  /** Root lint config fact from detectLintConfig — never read or evaluated (#3039). */
  lintConfig: LintConfigProbe | null;
}

// Root lint config candidates; order is the precedence order (#3039).
const LINT_CONFIG_CANDIDATES: ReadonlyArray<{ path: string; linter: LintConfigLinter; format: LintConfigFormat }> = [
  { path: 'oxlint.config.ts', linter: 'oxlint', format: 'executable' },
  { path: 'oxlint.config.mts', linter: 'oxlint', format: 'executable' },
  { path: 'oxlint.config.cts', linter: 'oxlint', format: 'executable' },
  { path: 'oxlint.config.js', linter: 'oxlint', format: 'executable' },
  { path: 'oxlint.config.mjs', linter: 'oxlint', format: 'executable' },
  { path: 'oxlint.config.cjs', linter: 'oxlint', format: 'executable' },
  { path: '.oxlintrc.json', linter: 'oxlint', format: 'json' },
  { path: 'eslint.config.js', linter: 'eslint', format: 'executable' },
  { path: 'eslint.config.mjs', linter: 'eslint', format: 'executable' },
  { path: 'eslint.config.cjs', linter: 'eslint', format: 'executable' },
  { path: 'eslint.config.ts', linter: 'eslint', format: 'executable' },
  { path: 'eslint.config.mts', linter: 'eslint', format: 'executable' },
  { path: 'eslint.config.cts', linter: 'eslint', format: 'executable' },
  { path: '.eslintrc.js', linter: 'eslint', format: 'executable' },
  { path: '.eslintrc.cjs', linter: 'eslint', format: 'executable' },
  { path: '.eslintrc.yaml', linter: 'eslint', format: 'yaml' },
  { path: '.eslintrc.yml', linter: 'eslint', format: 'yaml' },
  { path: '.eslintrc.json', linter: 'eslint', format: 'json' },
  { path: '.eslintrc', linter: 'eslint', format: 'yaml' }, // legacy: ESLint parses it as YAML (a JSON superset)
  { path: 'biome.json', linter: 'biome', format: 'json' },
  { path: 'biome.jsonc', linter: 'biome', format: 'json' },
];

const PLAYWRIGHT_CONFIG_FILES = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
];

// Generated output, not product source — scanning these produces false
// positives (e.g. a coverage HTML report embeds source text like `href="#"`
// literals from the checkers themselves as syntax-highlighted code, not markup).
const GENERATED_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build', '.next', 'out']);

// Python-world generated/vendored dirs, skipped alongside GENERATED_DIRS when
// walking for convention test surfaces (a test_*.py inside .venv is not ours).
const PYTHON_SKIP_DIRS = new Set(['__pycache__', '.venv', 'venv', '.tox']);

const PYTHON_TEST_FILE = /^test_.*\.py$/;

export async function probeWorktree(worktree: string): Promise<WorktreeProbe> {
  const packageJson = await probePackageJson(worktree);
  const htmlFiles = await findHtmlFiles(worktree);
  const pythonTestSurface = await detectPythonTestSurface(worktree);
  const lintConfig = await detectLintConfig(worktree);

  const playwrightConfigFiles: string[] = [];
  const playwrightConfigContents: Record<string, string> = {};
  for (const f of PLAYWRIGHT_CONFIG_FILES) {
    if (await fileExists(join(worktree, f))) {
      playwrightConfigFiles.push(f);
      playwrightConfigContents[f] = await readFile(join(worktree, f), 'utf-8').catch(() => '');
    }
  }

  const scripts: Record<string, string> = {};
  if (packageJson.status === 'loaded' && typeof packageJson.value === 'object' && packageJson.value !== null) {
    const raw = packageJson.value.scripts;
    if (typeof raw === 'object' && raw !== null) {
      for (const [name, script] of Object.entries(raw)) {
        if (typeof script === 'string') scripts[name] = script;
      }
    }
  }

  return {
    packageJson,
    htmlFiles,
    playwrightConfigFiles,
    playwrightConfigContents,
    scripts,
    pythonTestSurface,
    lintConfig,
  };
}

/** Detect the root lint config by filename only (#3039). Stats paths, never reads, imports or evaluates them.
 *  First candidate in precedence order wins; null when none exists (fail-open like detectPythonTestSurface). */
export async function detectLintConfig(worktree: string): Promise<LintConfigProbe | null> {
  for (const c of LINT_CONFIG_CANDIDATES) {
    if (await fileExists(join(worktree, c.path))) {
      return { linter: c.linter, configPath: c.path, format: c.format, executable: c.format === 'executable' };
    }
  }
  return null;
}

/** True when any line of the ini-style content, trimmed, is exactly the section header. */
function hasIniSection(content: string, header: string): boolean {
  return content.split(/\r?\n/).some((line) => line.trim() === header);
}

/** Detect a Python (pytest) test surface — config-declared and convention — without running anything (#1217).
 *  Every check is fail-open: a missing or unreadable candidate contributes no source. */
export async function detectPythonTestSurface(worktree: string): Promise<PythonTestSurface> {
  const sources: PythonTestSurfaceSource[] = [];

  const pyproject = await readFile(join(worktree, 'pyproject.toml'), 'utf-8').catch(() => '');
  if (hasIniSection(pyproject, '[tool.pytest.ini_options]')) sources.push('pyproject.toml');

  // pytest treats the file's existence alone as its config declaration
  if (await fileExists(join(worktree, 'pytest.ini'))) sources.push('pytest.ini');

  const setupCfg = await readFile(join(worktree, 'setup.cfg'), 'utf-8').catch(() => '');
  if (hasIniSection(setupCfg, '[tool:pytest]')) sources.push('setup.cfg');

  const toxIni = await readFile(join(worktree, 'tox.ini'), 'utf-8').catch(() => '');
  if (hasIniSection(toxIni, '[pytest]')) sources.push('tox.ini');

  if (await containsPythonTestFile(join(worktree, 'tests'))) sources.push('tests/');

  if (await containsPythonTestFile(join(worktree, '.factory/tests'))) sources.push('.factory/tests/');

  const topLevel = await readdir(worktree, { withFileTypes: true }).catch(() => []);
  if (topLevel.some((entry) => entry.isFile() && PYTHON_TEST_FILE.test(entry.name))) sources.push('test_*.py');

  return { present: sources.length > 0, sources };
}

/** Recursive test_*.py existence check under dir, skipping generated/venv dirs; short-circuits on first match. */
async function containsPythonTestFile(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (entry.isFile() && PYTHON_TEST_FILE.test(entry.name)) return true;
  }
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      !GENERATED_DIRS.has(entry.name) &&
      !PYTHON_SKIP_DIRS.has(entry.name) &&
      (await containsPythonTestFile(join(dir, entry.name)))
    ) {
      return true;
    }
  }
  return false;
}

async function probePackageJson(worktree: string): Promise<PackageJsonProbe> {
  let raw: string;
  try {
    raw = await readFile(join(worktree, 'package.json'), 'utf-8');
  } catch (e: unknown) {
    if (isEnoent(e)) return { status: 'absent' };
    return { status: 'unreadable', error: e };
  }
  try {
    return { status: 'loaded', value: JSON.parse(raw) as PackageJson };
  } catch (e) {
    return { status: 'unreadable', error: e };
  }
}

function isEnoent(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'ENOENT';
}

/** Placeholder-link count — the single home of the expression the checkers used to duplicate. */
export function countPlaceholderLinks(html: string): number {
  return html.split(/\r?\n/).filter((l) => l.includes('href="#"')).length;
}

/** Recursive relative `.html` walk, skipping generated-output directories. */
export async function findHtmlFiles(worktree: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (GENERATED_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        results.push(relative(worktree, join(dir, entry.name)));
      }
    }
  }

  await walk(worktree);
  results.sort();
  return results;
}

/** True when the path exists and is a regular file — directories and missing paths return false. */
export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
