// src/router/worktree-state.ts — snapshot/reset guard for the router's attempt
// lifecycle: capture worktree state before the first attempt of an agentic
// build task, then hard-reset back to it before every retry/failover attempt.

import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import type { ExecFn } from '../utils/exec.js';
import { shellEscape } from '../utils/index.js';

export type GitExecFn = ExecFn;

export interface WorktreeSnapshot {
  headSha: string;
  /** Raw `git status --porcelain` output at capture time. */
  statusText: string;
  /** Untracked paths present at capture time (porcelain lines starting '??'). */
  untrackedPaths: string[];
}

const GIT_OPTS = { timeoutMs: 30_000, maxBuffer: 10 * 1024 * 1024 };

export async function captureWorktreeState(
  execFn: GitExecFn,
  worktree: string,
  onLog: (msg: string) => void,
): Promise<WorktreeSnapshot | null> {
  let toplevel: string;
  try {
    const { stdout } = await execFn('git rev-parse --show-toplevel', { cwd: worktree, ...GIT_OPTS });
    toplevel = stdout.trim();
  } catch {
    onLog(`worktree state guard disabled: ${worktree} is not a git worktree root`);
    return null;
  }
  if (resolve(toplevel) !== resolve(worktree)) {
    onLog(`worktree state guard disabled: ${worktree} is not a git worktree root`);
    return null;
  }

  let headSha: string;
  try {
    const { stdout } = await execFn('git rev-parse HEAD', { cwd: worktree, ...GIT_OPTS });
    headSha = stdout.trim();
  } catch {
    onLog(`worktree state guard disabled: ${worktree} is not a git worktree root`);
    return null;
  }

  const { stdout: statusText } = await execFn('git status --porcelain', { cwd: worktree, ...GIT_OPTS });
  const lines = statusText
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (lines.some((line) => !line.startsWith('??'))) {
    onLog('worktree state guard disabled: baseline has uncommitted tracked changes');
    return null;
  }

  const untrackedPaths = parseGitStatusPaths(statusText);
  return { headSha, statusText, untrackedPaths };
}

export async function resetWorktreeState(
  execFn: GitExecFn,
  worktree: string,
  snapshot: WorktreeSnapshot,
  onLog: (msg: string) => void,
): Promise<{ didReset: boolean; tracePath?: string }> {
  const { stdout: headSha } = await execFn('git rev-parse HEAD', { cwd: worktree, ...GIT_OPTS });
  const { stdout: statusText } = await execFn('git status --porcelain', { cwd: worktree, ...GIT_OPTS });
  if (headSha.trim() === snapshot.headSha && statusText === snapshot.statusText) {
    return { didReset: false };
  }

  let tracePath: string | undefined;
  try {
    const { stdout: diffText } = await execFn('git diff HEAD', { cwd: worktree, ...GIT_OPTS });
    const traceDir = join(tmpdir(), 'factory-attempt-traces');
    await mkdir(traceDir, { recursive: true });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const candidatePath = join(traceDir, `${basename(worktree)}-${stamp}.patch`);
    const blob = `${statusText}\n${diffText}`;
    await writeFile(candidatePath, blob);
    tracePath = candidatePath;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onLog(`warning: failed to write attempt trace before reset: ${message}`);
  }

  await execFn(`git reset --hard ${shellEscape(snapshot.headSha)}`, { cwd: worktree, ...GIT_OPTS });
  const cleanArgs = snapshot.untrackedPaths.map((path) => `-e ${shellEscape(path)}`).join(' ');
  await execFn(`git clean -fd${cleanArgs ? ` ${cleanArgs}` : ''}`, { cwd: worktree, ...GIT_OPTS });

  return { didReset: true, ...(tracePath ? { tracePath } : {}) };
}

function parseGitStatusPaths(status: string): string[] {
  return status
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith('??'))
    .map((line) => {
      const path = line.slice(3).trim();
      return path.includes(' -> ') ? path.split(' -> ').pop()!.trim() : path;
    })
    .filter(Boolean);
}
