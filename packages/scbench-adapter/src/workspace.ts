// packages/scbench-adapter/src/workspace.ts — SCBench workspace prepare/reuse (#510).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { execa } from 'execa';

import { AdapterError } from './checkpoint.js';
import { WORKSPACE_CONSTITUTION } from './workspace-constitution.js';

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecFn {
  (argv: readonly string[], opts: { cwd: string; env?: Record<string, string | undefined> }): Promise<ExecResult>;
}

export interface WorkspaceDeps {
  exec: ExecFn;
}

/** Real, argv-based (no shell) execa runner — never throws on non-zero exit.
 *  On a spawn failure (e.g. the binary is missing) execa's own stdout/stderr
 *  are left undefined; fall back to its shortMessage so the failure reason
 *  isn't silently dropped. An `env` overlay merges over process.env; an
 *  undefined value un-sets that variable in the child (Node spawn drops
 *  undefined-valued env entries). */
export function createExecaExec(): ExecFn {
  return async (argv, opts) => {
    const [cmd, ...args] = argv;
    const result = await execa(cmd, args, { cwd: opts.cwd, env: opts.env, reject: false });
    const rawStderr = typeof result.stderr === 'string' ? result.stderr : '';
    const isSpawnFailure = result.failed && typeof result.exitCode !== 'number';
    return {
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : -1,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: rawStderr.length === 0 && isSpawnFailure ? (result.shortMessage ?? '') : rawStderr,
    };
  };
}

/** Factory state plus transient benchmark/runtime artifacts (Python bytecode,
 *  test-tool caches) that must never reach checkpoint commits or diffs (#1162). */
const GIT_EXCLUDE_ENTRIES = [
  '.factory/',
  '__pycache__/',
  '*.pyc',
  '.pytest_cache/',
  '.mypy_cache/',
  '.ruff_cache/',
  '.coverage',
] as const;
const GIT_USER_ARGS = ['-c', 'user.email=scbench@local', '-c', 'user.name=scbench'];

/** Read a file's content, treating "does not exist" as empty. Reads directly
 *  instead of check-then-read (existsSync followed by readFileSync) so there
 *  is no TOCTOU window between the check and the read. */
function readIfPresent(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/** Idempotent: git-inits (with an initial commit) only when .git is absent,
 *  ensures .factory/{,logs,plans} exist without requiring `factory init` or
 *  a GitHub token, pins .factory/config.json to providers.ollama=false when
 *  absent, (re)writes the factory-authored constitution (#1184), and excludes
 *  .factory/ plus transient benchmark/runtime artifacts via
 *  .git/info/exclude so neither Factory state nor cache churn pollutes
 *  SCBench's evaluation or diffs. */
export async function prepareWorkspace(dir: string, deps: WorkspaceDeps): Promise<void> {
  if (!existsSync(join(dir, '.git'))) {
    const init = await deps.exec(['git', 'init'], { cwd: dir });
    if (init.exitCode !== 0) {
      // Fail fast rather than falling through to the .factory/.git/info
      // setup below, which would mkdirSync a `.git` directory of its own and
      // fool the existsSync check above on every later call — permanently
      // masking a workspace that was never actually a git repo.
      throw new AdapterError(`git init failed for workspace ${dir}: ${init.stderr || init.stdout}`);
    }
    await deps.exec(['git', 'add', '-A'], { cwd: dir });
    await deps.exec(['git', ...GIT_USER_ARGS, 'commit', '--allow-empty', '-m', 'scbench: initial workspace'], {
      cwd: dir,
    });
  }

  for (const sub of ['.factory', '.factory/logs', '.factory/plans']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }

  const configPath = join(dir, '.factory', 'config.json');
  try {
    writeFileSync(configPath, `${JSON.stringify({ version: 1, providers: { ollama: false } }, null, 2)}\n`, {
      flag: 'wx',
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  // Always (re)write the factory-authored standards so the nested factory
  // run injects them into every phase (loadRepoConstitution reads this
  // path); .factory/ is git-excluded, so it never reaches SCBench diffs.
  writeFileSync(join(dir, '.factory', 'constitution.md'), WORKSPACE_CONSTITUTION);

  const excludeFile = join(dir, '.git', 'info', 'exclude');
  const existing = readIfPresent(excludeFile);
  const existingLines = new Set(existing.split('\n'));
  const missing = GIT_EXCLUDE_ENTRIES.filter((entry) => !existingLines.has(entry));
  if (missing.length > 0) {
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    writeFileSync(excludeFile, `${existing}${separator}${missing.join('\n')}\n`);
  }
}

/** git add -A + commit; tolerates "nothing to commit" (a checkpoint that made
 *  no workspace changes). Any other git failure is an AdapterError. */
export async function commitCheckpoint(dir: string, checkpointId: string, deps: WorkspaceDeps): Promise<void> {
  await deps.exec(['git', 'add', '-A'], { cwd: dir });
  const result = await deps.exec(['git', ...GIT_USER_ARGS, 'commit', '-m', `scbench: checkpoint ${checkpointId}`], {
    cwd: dir,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode !== 0 && !/nothing to commit/i.test(output)) {
    throw new AdapterError(`git commit failed for checkpoint ${checkpointId}: ${result.stderr || result.stdout}`);
  }
}
