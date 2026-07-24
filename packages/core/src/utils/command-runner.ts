// packages/core/src/utils/command-runner.ts — shared argv-based command runner (no shell)
import { spawn } from 'node:child_process';

import { execa } from 'execa';

import { killProcessGroup } from '../environment/process-groups.js';

export interface RunCommandOptions {
  cwd?: string;
  /** Milliseconds. Always ms — call sites must not pass seconds. */
  timeoutMs?: number;
  maxBuffer?: number;
  env?: Record<string, string>;
  /** When set, the child is spawned detached (its own process group) and
   *  its pid is reported here so a lane can track and later kill the
   *  whole group. */
  onPgid?: (pgid: number) => void;
  /** Grace period before SIGKILL when sweeping the group after termination. */
  killGraceMs?: number;
}

export interface CommandResult {
  /** The argv that ran, for diagnostics. */
  command: readonly string[];
  stdout: string;
  stderr: string;
  /** -1 when the process produced no exit code (spawn failure or killed). */
  exitCode: number;
  /** True when the process was terminated by a signal (incl. timeout kill). */
  killed: boolean;
  /** True when terminated because timeoutMs elapsed. */
  timedOut: boolean;
  /** exitCode === 0 && !killed && !timedOut */
  ok: boolean;
}

const DEFAULT_MAX_BUFFER = 1000 * 1000 * 100;

/** argv-based (no shell) detached run for the `onPgid` path. Resolves on the
 *  child's own `exit`, not on its piped stdio closing: a backgrounded
 *  grandchild (e.g. a dev server the checker command starts) would
 *  otherwise keep the inherited pipe open past the direct child's own exit,
 *  hanging execa's stream-aware result past any timeout. After settling, a
 *  timeout or any signal-based termination triggers a `killProcessGroup`
 *  sweep so such grandchildren don't outlive the check. */
async function runCommandDetached(argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const child = spawn(argv[0], argv.slice(1), {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    detached: true,
  });

  const pid = child.pid;
  if (pid !== undefined) options.onPgid?.(pid);

  let stdoutLen = 0;
  let stderrLen = 0;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let maxBufferExceeded = false;
  let timedOut = false;

  const timer =
    options.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeoutMs)
      : undefined;

  const { exitCode, signal } = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutLen += chunk.length;
        if (stdoutLen > maxBuffer) {
          maxBufferExceeded = true;
          child.kill();
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrLen += chunk.length;
        if (stderrLen > maxBuffer) {
          maxBufferExceeded = true;
          child.kill();
          return;
        }
        stderrChunks.push(chunk);
      });
      child.on('error', () => resolve({ exitCode: -1, signal: null }));
      child.on('exit', (code, sig) => resolve({ exitCode: code, signal: sig }));
    },
  );

  if (timer) clearTimeout(timer);

  const isTerminated = timedOut || maxBufferExceeded || signal !== null;
  if (isTerminated && pid !== undefined) {
    await killProcessGroup(pid, { graceMs: options.killGraceMs });
  }

  return {
    command: argv,
    stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
    stderr: Buffer.concat(stderrChunks).toString('utf-8'),
    exitCode: typeof exitCode === 'number' ? exitCode : -1,
    killed: isTerminated,
    timedOut,
    ok: exitCode === 0 && !isTerminated,
  };
}

export async function runCommand(argv: readonly string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  if (argv.length === 0 || argv[0].trim() === '') {
    throw new TypeError('runCommand: argv must be non-empty and argv[0] must not be blank');
  }

  if (options.onPgid) {
    return runCommandDetached(argv, options);
  }

  const r = await execa(argv[0], argv.slice(1), {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer,
    env: options.env,
    extendEnv: true,
    reject: false,
    all: false,
  });

  const exitCode = typeof r.exitCode === 'number' ? r.exitCode : -1;
  const killed = r.isTerminated === true;
  const timedOut = r.timedOut === true;
  const stdout = typeof r.stdout === 'string' ? r.stdout : '';
  const stderr =
    r.failed && typeof r.exitCode !== 'number' ? (r.shortMessage ?? '') : typeof r.stderr === 'string' ? r.stderr : '';

  return {
    command: argv,
    stdout,
    stderr,
    exitCode,
    killed,
    timedOut,
    ok: exitCode === 0 && !killed && !timedOut,
  };
}

/** First non-empty of stderr, stdout, or an exit-code note — for FAIL details. */
export function describeCommandFailure(r: CommandResult): string {
  return r.stderr || r.stdout || (r.timedOut ? `timed out` : `exit code ${r.exitCode}`);
}
