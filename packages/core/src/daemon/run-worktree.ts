import { copyFile, lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execa } from 'execa';

/** A run owns its checkout, branch and .factory state. Retain it for inspection after completion. */
export async function prepareRunWorktree(repo: string, runId: string): Promise<string> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(runId))
    throw new Error('Invalid run identifier');
  const git = (...args: string[]) => execa('git', args, { cwd: repo, timeout: 30_000 });
  const common = resolve(repo, (await git('rev-parse', '--git-common-dir')).stdout);
  const path = join(common, 'factory-runs', runId);
  const branch = `codex/run-${runId}`;
  try {
    const stat = await lstat(join(path, '.git'));
    if (!stat.isFile()) throw new Error('Unexpected run worktree');
    const current = await execa('git', ['branch', '--show-current'], { cwd: path });
    if (current.stdout !== branch) throw new Error('Run worktree branch mismatch');
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(join(common, 'factory-runs'), { recursive: true });
  await git('worktree', 'add', '-b', branch, path, 'HEAD');
  await mkdir(join(path, '.factory'), { recursive: true });
  try {
    await copyFile(join(repo, '.factory', 'config.json'), join(path, '.factory', 'config.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return path;
}
