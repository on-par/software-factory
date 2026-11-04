import { glob, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { tokenizeEvidenceCommand } from './evidence-allowlist.js';
import type { FailToPassSelector } from './evidence-selector.js';
import { runnerFromScript, selectorArgs } from './evidence-selector.js';

export interface WorkspaceTestRunner {
  /** posix path relative to the worktree, no leading ./ or trailing / */
  dir: string;
  /** workspace package.json name */
  name: string | null;
  runner: 'vitest' | 'jest';
  manager: 'npm' | 'pnpm' | 'yarn';
}

const MAX_WORKSPACES = 200;

/** The package manager when a root `test` script body fans out to the workspaces, else null. */
export function isWorkspaceTestFanOut(body: string): 'npm' | 'pnpm' | 'yarn' | null {
  const tokens = tokenizeEvidenceCommand(body);
  if (!tokens) return null;
  if (tokens[0] === 'npm') {
    return tokens.includes('test') && (tokens.includes('--workspaces') || tokens.includes('-ws')) ? 'npm' : null;
  }
  if (tokens[0] === 'pnpm') {
    return (tokens.includes('-r') || tokens.includes('--recursive')) && tokens.includes('test') ? 'pnpm' : null;
  }
  if (tokens[0] === 'yarn' && tokens[1] === 'workspaces') {
    if (tokens[2] === 'run' && tokens[3] === 'test') return 'yarn';
    if (tokens[2] === 'foreach') {
      const run = tokens.indexOf('run');
      return run >= 0 && tokens[run + 1] === 'test' ? 'yarn' : null;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : null;
}

async function workspacePatterns(
  worktree: string,
  root: Record<string, unknown>,
  manager: 'npm' | 'pnpm' | 'yarn',
): Promise<string[]> {
  if (manager === 'pnpm') {
    const yaml: unknown = parseYaml(await readFile(join(worktree, 'pnpm-workspace.yaml'), 'utf8'));
    return (isRecord(yaml) ? stringArray(yaml.packages) : null) ?? [];
  }
  const { workspaces } = root;
  return stringArray(workspaces) ?? (isRecord(workspaces) ? stringArray(workspaces.packages) : null) ?? [];
}

function safePattern(pattern: string): boolean {
  return !pattern.startsWith('!') && !pattern.startsWith('/') && !pattern.split(/[\\/]/).includes('..');
}

function normalizeDir(dir: string): string {
  return dir
    .replaceAll('\\', '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '');
}

async function workspaceDirs(worktree: string, patterns: readonly string[]): Promise<string[]> {
  const dirs = new Set<string>();
  for (const pattern of patterns.filter(safePattern)) {
    const manifest = `${normalizeDir(pattern)}/package.json`;
    for await (const match of glob(manifest, { cwd: worktree, exclude: (name) => name === 'node_modules' })) {
      dirs.add(normalizeDir(match.slice(0, -'package.json'.length)));
      if (dirs.size >= MAX_WORKSPACES) return [...dirs];
    }
  }
  return [...dirs];
}

/** Workspaces of a fan-out monorepo whose own `test` script runs vitest or jest. Never throws. */
export async function resolveWorkspaceTestRunners(
  worktree: string,
  packageJson: unknown,
): Promise<WorkspaceTestRunner[]> {
  try {
    if (!isRecord(packageJson) || !isRecord(packageJson.scripts)) return [];
    const rootTest = packageJson.scripts.test;
    const manager = typeof rootTest === 'string' ? isWorkspaceTestFanOut(rootTest) : null;
    if (!manager) return [];
    const found: WorkspaceTestRunner[] = [];
    for (const dir of await workspaceDirs(worktree, await workspacePatterns(worktree, packageJson, manager))) {
      try {
        const pkg: unknown = JSON.parse(await readFile(join(worktree, dir, 'package.json'), 'utf8'));
        if (!isRecord(pkg) || !isRecord(pkg.scripts) || typeof pkg.scripts.test !== 'string') continue;
        const runner = runnerFromScript(pkg.scripts.test);
        if (runner !== 'vitest' && runner !== 'jest') continue;
        const name = typeof pkg.name === 'string' ? pkg.name : null;
        if (manager === 'yarn' && name === null) continue;
        found.push({ dir, name, runner, manager });
      } catch {
        continue;
      }
    }
    return found.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  } catch {
    return [];
  }
}

/** The workspace with the longest directory prefix of `file`, with the file relative to it. */
export function ownerWorkspace(
  file: string,
  workspaces: readonly WorkspaceTestRunner[],
): { workspace: WorkspaceTestRunner; relativeFile: string } | null {
  const path = file.replace(/^\.\//, '');
  let best: WorkspaceTestRunner | null = null;
  for (const workspace of workspaces) {
    if (path.startsWith(`${workspace.dir}/`) && (!best || workspace.dir.length > best.dir.length)) best = workspace;
  }
  return best ? { workspace: best, relativeFile: path.slice(best.dir.length + 1) } : null;
}

/** argv that runs `selector` (file relative to the workspace) with the workspace's runner. */
export function workspaceSelectorArgv(workspace: WorkspaceTestRunner, selector: FailToPassSelector): string[] {
  const bin = workspace.runner;
  const run = bin === 'vitest' ? [bin, 'run'] : [bin];
  const { dir, manager } = workspace;
  const prefix =
    manager === 'npm'
      ? ['npm', 'exec', '--workspace', dir, '--', ...run]
      : manager === 'pnpm'
        ? ['pnpm', '--dir', dir, 'exec', ...run]
        : ['yarn', 'workspace', workspace.name ?? dir, ...run];
  return [...prefix, ...selectorArgs(selector, workspace.runner)];
}
