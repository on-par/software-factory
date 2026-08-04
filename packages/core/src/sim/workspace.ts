// packages/core/src/sim/workspace.ts — throwaway local git workspace for simulated runs:
// a bare "origin" plus a clone, both under the OS temp dir, so pushes never leave the machine.

import { exec as execCb } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execCb);

export interface SimWorkspace {
  /** Bare repo standing in for the GitHub remote — a local path, so pushes never touch the network. */
  origin: string;
  /** Clone that lane worktrees are created from. */
  repoRoot: string;
  /** Directory frozen specs (and their design artifacts) are written to. */
  plansDir: string;
  /** Removes every directory this workspace created. Safe to call more than once. */
  dispose(): Promise<void>;
}

export async function simCommitAll(cwd: string, message: string): Promise<void> {
  await exec('git add -A', { cwd });
  await exec(`git commit -m '${message}'`, { cwd });
}

export async function createSimWorkspace(): Promise<SimWorkspace> {
  const origin = realpathSync(await mkdtemp(join(tmpdir(), 'factory-origin-')));
  const repoRoot = realpathSync(await mkdtemp(join(tmpdir(), 'factory-repo-')));
  const plansRoot = realpathSync(await mkdtemp(join(tmpdir(), 'factory-plan-')));
  const plansDir = join(plansRoot, 'plans');
  await mkdir(plansDir, { recursive: true });

  await exec('git -c init.defaultBranch=main init --bare', { cwd: origin });
  await exec(`git clone '${origin}' '${repoRoot}'`);
  await exec('git config user.name factory-test', { cwd: repoRoot });
  await exec('git config user.email factory@test', { cwd: repoRoot });
  await exec('git checkout -b main', { cwd: repoRoot });
  await writeFile(join(repoRoot, 'README.md'), '# Throwaway\n');
  await simCommitAll(repoRoot, 'chore: initial commit');
  await exec('git push -u origin main', { cwd: repoRoot });

  return {
    origin,
    repoRoot,
    plansDir,
    async dispose(): Promise<void> {
      await Promise.all([origin, repoRoot, plansRoot].map((dir) => rm(dir, { recursive: true, force: true })));
    },
  };
}
