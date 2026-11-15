import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export const GIT_COMMAND_TIMEOUT_MS = 120_000;

export interface GitExecOptions {
  cwd?: string;
  timeoutMs?: number;
  noPrompt?: boolean;
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
}

function isNodeTimeoutKillRejection(err: unknown): boolean {
  const e = err as { killed?: unknown; signal?: unknown } | null;
  return Boolean(e) && e?.killed === true && typeof e?.signal === 'string';
}

export async function execGit(args: readonly string[], opts: GitExecOptions = {}): Promise<GitExecResult> {
  const timeoutMs = opts.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS;
  try {
    return await execFile('git', args, {
      cwd: opts.cwd,
      timeout: timeoutMs,
      env: opts.noPrompt ? { ...process.env, GIT_TERMINAL_PROMPT: '0' } : undefined,
    });
  } catch (err) {
    if (!isNodeTimeoutKillRejection(err)) throw err;
    const cmd = ['git', ...args].join(' ');
    const where = opts.cwd === undefined ? '' : ` (cwd ${opts.cwd})`;
    throw Object.assign(new Error(`git command timed out after ${timeoutMs}ms and was killed${where}: ${cmd}`), {
      name: 'GitTimeoutError',
      cmd,
      cwd: opts.cwd,
      timeoutMs,
    });
  }
}
