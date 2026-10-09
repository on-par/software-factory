// packages/core/src/sim/workspace.ts — throwaway local git workspace for simulated runs:
// a bare "origin" plus a clone, both under the OS temp dir, so pushes never leave the machine.

import { realpathSync, rmSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execGit } from '../utils/git-exec.js';

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
  await execGit(['add', '-A'], { cwd });
  await execGit(['commit', '-m', message], { cwd });
}

interface SimTemplate {
  origin: string;
  repoRoot: string;
}

let template: Promise<SimTemplate> | undefined;

/**
 * Builds the pristine origin + clone once per process. Every workspace is a
 * byte copy of it, so creating one costs a directory copy and a single git
 * call instead of eight git subprocesses. On a host at load average 100+,
 * process spawn latency dominated these fixtures and pushed the real-git unit
 * tests that use them past their deadline (Gate 0, base-red at 9024b07).
 */
async function buildTemplate(): Promise<SimTemplate> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'factory-sim-template-')));
  process.once('exit', () => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin');
  const repoRoot = join(root, 'repo');
  await mkdir(origin);

  await execGit(['-c', 'init.defaultBranch=main', 'init', '--bare'], { cwd: origin });
  await execGit(['clone', origin, repoRoot]);
  await execGit(['config', 'user.name', 'factory-test'], { cwd: repoRoot });
  await execGit(['config', 'user.email', 'factory@test'], { cwd: repoRoot });
  await execGit(['checkout', '-b', 'main'], { cwd: repoRoot });
  await writeFile(join(repoRoot, 'README.md'), '# Throwaway\n');
  await simCommitAll(repoRoot, 'chore: initial commit');
  await execGit(['push', '-u', 'origin', 'main'], { cwd: repoRoot });
  return { origin, repoRoot };
}

function simTemplate(): Promise<SimTemplate> {
  template ??= buildTemplate().catch((err: unknown) => {
    template = undefined;
    throw err;
  });
  return template;
}

export async function createSimWorkspace(): Promise<SimWorkspace> {
  const tpl = await simTemplate();
  const origin = realpathSync(await mkdtemp(join(tmpdir(), 'factory-origin-')));
  const repoRoot = realpathSync(await mkdtemp(join(tmpdir(), 'factory-repo-')));
  const plansRoot = realpathSync(await mkdtemp(join(tmpdir(), 'factory-plan-')));
  const plansDir = join(plansRoot, 'plans');
  await mkdir(plansDir, { recursive: true });

  await Promise.all([cp(tpl.origin, origin, { recursive: true }), cp(tpl.repoRoot, repoRoot, { recursive: true })]);
  // The copied clone still points at the template's origin; repoint it at this workspace's own.
  await execGit(['remote', 'set-url', 'origin', origin], { cwd: repoRoot });

  return {
    origin,
    repoRoot,
    plansDir,
    async dispose(): Promise<void> {
      await Promise.all([origin, repoRoot, plansRoot].map((dir) => rm(dir, { recursive: true, force: true })));
    },
  };
}
