// src/utils/git-exec.ts — one place where every git subprocess gets a deadline.

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execCb);

/**
 * Hard ceiling for a single git subprocess. Long enough that a slow-but-live
 * fetch or clone on a large repo still finishes, short enough that a wedged
 * process fails a run in minutes rather than hours.
 */
export const GIT_COMMAND_TIMEOUT_MS = 120_000;

export interface GitExecOptions {
  cwd?: string;
  /** Override the default ceiling. Mostly for tests. */
  timeoutMs?: number;
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
}

/** True for the rejection node produces when it kills a child on timeout. */
function isTimeoutRejection(err: unknown): boolean {
  const e = err as { killed?: unknown; signal?: unknown } | null;
  return Boolean(e) && e?.killed === true && typeof e?.signal === 'string';
}

/**
 * Runs one git command with an explicit timeout, killing the child on expiry.
 *
 * Without a timeout a git subprocess that wedges — on its own worktree metadata
 * lock, on an unresponsive filesystem, on a credential prompt with no tty —
 * hangs its caller forever and emits nothing, which is unfalsifiable from a CI
 * log (#755). Node kills the child on expiry but reports it as a generic
 * "Command failed" rejection, indistinguishable from git exiting non-zero on
 * its own, so that case is rewritten here into a named timeout error.
 */
export async function execGit(cmd: string, opts: GitExecOptions = {}): Promise<GitExecResult> {
  const timeoutMs = opts.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS;
  try {
    return await exec(cmd, { cwd: opts.cwd, timeout: timeoutMs });
  } catch (err) {
    if (!isTimeoutRejection(err)) throw err;
    const where = opts.cwd === undefined ? '' : ` (cwd ${opts.cwd})`;
    throw Object.assign(new Error(`git command timed out after ${timeoutMs}ms and was killed${where}: ${cmd}`), {
      name: 'GitTimeoutError',
      cmd,
      cwd: opts.cwd,
      timeoutMs,
    });
  }
}
