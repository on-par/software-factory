import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { checkCommandArgv, type CheckKind, type ChecksConfig } from '../config/checks-section.js';
import { getFactoryPaths } from '../config/index.js';
import { loadRepoConfig } from '../config/repo.js';
import { REPO_CONFIG_FILENAMES } from '../config/repo-config-file.js';
import { runConfigOrigin, runConfigSource } from '../config/run-config-source.js';
import { detectPythonTestSurface, fileExists, type WorktreeProbe } from './probe.js';

export interface PackageJson {
  scripts?: Record<string, string>;
  [k: string]: unknown;
}

export interface LintCommandSource {
  worktree: string;
  packageJson?: PackageJson | null;
  probe?: WorktreeProbe;
  checks?: ChecksConfig | null;
}
export type ChecksConfigSource = `.factory/${string}`;

function declaredCheck(ctx: LintCommandSource, kind: CheckKind): { argv: string[]; source: ChecksConfigSource } | null {
  if (ctx.checks !== undefined) {
    const argv = checkCommandArgv(ctx.checks, kind);
    return argv ? { argv, source: '.factory/config.json' } : null;
  }
  const argv = checkCommandArgv(loadRepoConfig(ctx.worktree)?.checks, kind);
  if (!argv) return null;
  const readFromRunConfigSnapshotNotWorktreeFile = runConfigSource() !== undefined;
  const file = readFromRunConfigSnapshotNotWorktreeFile ? runConfigOrigin() : getFactoryPaths(ctx.worktree).config;
  return { argv, source: `.factory/${file === undefined ? 'config (run config snapshot)' : basename(file)}` };
}

export function describeChecksProbe(ctx: LintCommandSource, checkout = 'worktree'): string {
  if (ctx.checks !== undefined) return 'the checks passed to CHECK';
  if (runConfigSource() !== undefined) {
    const origin = runConfigOrigin();
    return origin === undefined
      ? 'the daemon run config snapshot (FACTORY_RUN_CONFIG_JSON)'
      : `the run config snapshot of ${origin}`;
  }
  const file = getFactoryPaths(ctx.worktree).config;
  if (existsSync(file)) return `${file} (${checkout})`;
  const others = REPO_CONFIG_FILENAMES.filter((name) => name !== basename(file));
  return `${file} (${checkout}; also probed ${others.join(', ')})`;
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
  if (await fileExists(join(w, 'Cargo.toml'))) return { argv: ['cargo', 'build'], source: 'Cargo.toml' };
  return (await getPackageJson(ctx))?.scripts?.typecheck
    ? { argv: ['npm', 'run', 'typecheck'], source: 'package.json' }
    : null;
}
export type TestsRunner = 'config' | 'verify' | 'verify-ps1' | 'npm' | 'pytest' | 'none';

export interface TestsCommand {
  runner: TestsRunner;
  argv: string[];
  label: string;
  source?: ChecksConfigSource;
}

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

export interface LintCommand {
  label: 'checks.lint' | 'lint' | 'tsc';
  argv: string[];
  source?: ChecksConfigSource;
}

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
    const missingPackageJsonIsASkipNotAnError = e?.code === 'ENOENT';
    if (missingPackageJsonIsASkipNotAnError) return null;
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
