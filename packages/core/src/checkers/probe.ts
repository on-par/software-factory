import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface PackageJson {
  scripts?: Record<string, string>;
  [k: string]: unknown;
}

export type PackageJsonProbe =
  { status: 'loaded'; value: PackageJson } | { status: 'absent' } | { status: 'unreadable'; error: unknown };

export type PythonTestSurfaceSource =
  'pyproject.toml' | 'pytest.ini' | 'setup.cfg' | 'tox.ini' | 'tests/' | '.factory/tests/' | 'test_*.py';

export interface PythonTestSurface {
  present: boolean;
  sources: PythonTestSurfaceSource[];
}

export type LintConfigLinter = 'oxlint' | 'eslint' | 'biome';
export type LintConfigFormat = 'json' | 'yaml' | 'executable';

export interface LintConfigProbe {
  linter: LintConfigLinter;
  configPath: string;
  format: LintConfigFormat;
  executable: boolean;
}

export interface WorktreeProbe {
  packageJson: PackageJsonProbe;
  htmlFiles: string[];
  playwrightConfigFiles: string[];
  playwrightConfigContents: Record<string, string>;
  scripts: Record<string, string>;
  pythonTestSurface: PythonTestSurface;
  lintConfig: LintConfigProbe | null;
}

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
  { path: '.eslintrc', linter: 'eslint', format: 'yaml' },
  { path: 'biome.json', linter: 'biome', format: 'json' },
  { path: 'biome.jsonc', linter: 'biome', format: 'json' },
];

const PLAYWRIGHT_CONFIG_FILES = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
];

const GENERATED_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build', '.next', 'out']);

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

export async function detectLintConfig(worktree: string): Promise<LintConfigProbe | null> {
  for (const c of LINT_CONFIG_CANDIDATES) {
    if (await fileExists(join(worktree, c.path))) {
      return { linter: c.linter, configPath: c.path, format: c.format, executable: c.format === 'executable' };
    }
  }
  return null;
}

function hasIniSection(content: string, header: string): boolean {
  return content.split(/\r?\n/).some((line) => line.trim() === header);
}

export async function detectPythonTestSurface(worktree: string): Promise<PythonTestSurface> {
  const sources: PythonTestSurfaceSource[] = [];

  const pyproject = await readFile(join(worktree, 'pyproject.toml'), 'utf-8').catch(() => '');
  if (hasIniSection(pyproject, '[tool.pytest.ini_options]')) sources.push('pyproject.toml');

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

export function countPlaceholderLinks(html: string): number {
  return html.split(/\r?\n/).filter((l) => l.includes('href="#"')).length;
}

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

export interface HtmlFileSelection {
  scanned: string[];
  ignored: string[];
}

export function partitionHtmlFiles(files: readonly string[], _ignore: readonly string[]): HtmlFileSelection {
  return { scanned: [...files], ignored: [] };
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
