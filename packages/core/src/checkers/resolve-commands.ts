// src/checkers/resolve-commands.ts — the build/test/lint commands CHECK runs for a worktree. A command the repo
// declares under `checks` in its config file wins; otherwise each resolver falls back to file-based guesses.

import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { checkCommandArgv, type CheckKind, type ChecksConfig } from '../config/checks-section.js';
import { getFactoryPaths } from '../config/index.js';
import { loadRepoConfig } from '../config/repo.js';
import { detectPythonTestSurface, fileExists, type WorktreeProbe } from './probe.js';

export interface PackageJson {
  scripts?: Record<string, string>;
  [k: string]: unknown;
}

/** Worktree facts the lint and compile resolvers read — a subset of CheckerContext so BUILD and doctor can call them with just `{ worktree }`. */
export interface LintCommandSource {
  worktree: string;
  packageJson?: PackageJson | null;
  probe?: WorktreeProbe;
  /** Test seam; when undefined, the resolvers read `checks` from the worktree's repo config file. */
  checks?: ChecksConfig | null;
}
/** Source label for a command declared under `checks`: the repo config file, relative to the repo root. */
export type ChecksConfigSource = `.factory/${string}`;

/** The repo-declared command for one check kind, or null. Throws on an invalid config file. */
function declaredCheck(ctx: LintCommandSource, kind: CheckKind): { argv: string[]; source: ChecksConfigSource } | null {
  if (ctx.checks !== undefined) {
    const argv = checkCommandArgv(ctx.checks, kind);
    return argv ? { argv, source: '.factory/config.json' } : null;
  }
  const argv = checkCommandArgv(loadRepoConfig(ctx.worktree)?.checks, kind);
  return argv ? { argv, source: `.factory/${basename(getFactoryPaths(ctx.worktree).config)}` } : null;
}

export type CompileCommand = {
  argv: string[];
  source: ChecksConfigSource | 'package.json' | 'Makefile' | 'Cargo.toml';
};
export async function resolveCompileCommand(ctx: LintCommandSource): Promise<CompileCommand | null> {
  const w = ctx.worktree;
  const declared = declaredCheck(ctx, 'build');
  if (declared) return declared;
  if ((await getPackageJson(ctx))?.scripts?.build) return { argv: ['npm', 'run', 'build'], source: 'package.json' };
  if (await fileExists(join(w, 'Makefile'))) return { argv: ['make'], source: 'Makefile' };
  return (await fileExists(join(w, 'Cargo.toml'))) ? { argv: ['cargo', 'build'], source: 'Cargo.toml' } : null;
}
export type TestsRunner = 'config' | 'verify' | 'verify-ps1' | 'npm' | 'pytest' | 'none';

/** The command the `tests` checker runs for a worktree; argv is [] when runner is 'none'. */
export interface TestsCommand {
  runner: TestsRunner;
  argv: string[];
  /** Label used in FAIL details and the output-log name (`checks.test`, `verify.sh`, `verify.ps1`, `npm test`, `pytest`, `''` for none). */
  label: string;
  /** Config file the command was declared in; set only for runner 'config'. */
  source?: ChecksConfigSource;
}

/** The CHECK command for a repo whose gate is scripts/verify.ps1; BUILD renders the same argv (#3471). */
export const VERIFY_PS1_ARGV = ['pwsh', '-NoProfile', '-NonInteractive', '-File', 'scripts/verify.ps1'] as const;

export async function resolveTestsCommand(ctx: LintCommandSource): Promise<TestsCommand> {
  const declared = declaredCheck(ctx, 'test');
  if (declared) return { runner: 'config', argv: declared.argv, label: 'checks.test', source: declared.source };
  if (await fileExists(join(ctx.worktree, 'scripts/verify.sh')))
    return { runner: 'verify', argv: ['bash', 'scripts/verify.sh', '--no-e2e'], label: 'verify.sh' };
  if (await fileExists(join(ctx.worktree, 'scripts/verify.ps1')))
    return { runner: 'verify-ps1', argv: [...VERIFY_PS1_ARGV], label: 'verify.ps1' };
  const pkg = await getPackageJson(ctx);
  if (pkg?.scripts?.test) return { runner: 'npm', argv: ['npm', 'test'], label: 'npm test' };
  const pythonSurface = ctx.probe?.pythonTestSurface ?? (await detectPythonTestSurface(ctx.worktree));
  if (!pythonSurface.present) return { runner: 'none', argv: [], label: '' };
  return {
    runner: 'pytest',
    argv: pythonSurface.sources.includes('.factory/tests/')
      ? ['python3', '-m', 'pytest', '.factory/tests']
      : ['python3', '-m', 'pytest'],
    label: 'pytest',
  };
}

/** One lint-family command the `lint` checker runs; label names it in details and the log file. */
export interface LintCommand {
  label: 'checks.lint' | 'lint' | 'tsc';
  argv: string[];
  /** Config file the command was declared in; set only for label 'checks.lint'. */
  source?: ChecksConfigSource;
}

/** Lint commands that apply, in run order. A declared `checks.lint` replaces the guesses; otherwise
 *  `npm run lint` (package.json lint script), then `npx tsc --noEmit` (tsconfig.json). */
export async function resolveLintCommands(ctx: LintCommandSource): Promise<LintCommand[]> {
  const declared = declaredCheck(ctx, 'lint');
  if (declared) return [{ label: 'checks.lint', ...declared }];
  const commands: LintCommand[] = [];
  const pkg = await getPackageJson(ctx);
  if (pkg?.scripts?.lint) commands.push({ label: 'lint', argv: ['npm', 'run', 'lint'] });
  if (await fileExists(join(ctx.worktree, 'tsconfig.json')))
    commands.push({ label: 'tsc', argv: ['npx', 'tsc', '--noEmit'] });
  return commands;
}

async function loadPackageJson(worktree: string): Promise<PackageJson | null> {
  let raw: string;
  try {
    raw = await readFile(join(worktree, 'package.json'), 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null; // no package.json is a legitimate skip, not an error
    throw e;
  }
  return JSON.parse(raw) as PackageJson;
}

export async function getPackageJson(ctx: LintCommandSource): Promise<PackageJson | null> {
  if (ctx.packageJson !== undefined) return ctx.packageJson;
  const p = ctx.probe?.packageJson;
  if (p) {
    switch (p.status) {
      case 'loaded':
        return p.value;
      case 'absent':
        return null;
      case 'unreadable':
        throw p.error;
    }
  }
  return loadPackageJson(ctx.worktree);
}
