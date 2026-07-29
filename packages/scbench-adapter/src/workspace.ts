// packages/scbench-adapter/src/workspace.ts — SCBench workspace prepare/reuse (#510).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { execa } from 'execa';

import { AdapterError } from './checkpoint.js';

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecFn {
  (argv: readonly string[], opts: { cwd: string }): Promise<ExecResult>;
}

export interface WorkspaceDeps {
  exec: ExecFn;
}

/** Real, argv-based (no shell) execa runner — never throws on non-zero exit. */
export function createExecaExec(): ExecFn {
  return async (argv, opts) => {
    const [cmd, ...args] = argv;
    const result = await execa(cmd, args, { cwd: opts.cwd, reject: false });
    return {
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : -1,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
    };
  };
}

const GIT_EXCLUDE_ENTRY = '.factory/';
const GIT_USER_ARGS = ['-c', 'user.email=scbench@local', '-c', 'user.name=scbench'];

/** Idempotent: git-inits (with an initial commit) only when .git is absent,
 *  ensures .factory/{,logs,plans} exist without requiring `factory init` or
 *  a GitHub token, and excludes .factory/ via .git/info/exclude so Factory
 *  state never pollutes SCBench's evaluation or diffs. */
export async function prepareWorkspace(dir: string, deps: WorkspaceDeps): Promise<void> {
  if (!existsSync(join(dir, '.git'))) {
    await deps.exec(['git', 'init'], { cwd: dir });
    await deps.exec(['git', 'add', '-A'], { cwd: dir });
    await deps.exec(['git', ...GIT_USER_ARGS, 'commit', '--allow-empty', '-m', 'scbench: initial workspace'], {
      cwd: dir,
    });
  }

  for (const sub of ['.factory', '.factory/logs', '.factory/plans']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }

  const excludeFile = join(dir, '.git', 'info', 'exclude');
  const existing = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf-8') : '';
  if (!existing.includes(GIT_EXCLUDE_ENTRY)) {
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    writeFileSync(excludeFile, `${existing}${separator}${GIT_EXCLUDE_ENTRY}\n`);
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
