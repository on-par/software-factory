// src/utils/exec.ts — Canonical exec seam with an explicit millisecond timeout.

import { exec as execCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { killProcessGroup } from '../environment/process-groups.js';

const exec = promisify(execCb);

const DEFAULT_MAX_BUFFER = 1024 * 1024;

export type ExecFn = (
  cmd: string,
  opts: {
    cwd?: string;
    timeoutMs?: number;
    maxBuffer?: number;
    env?: Record<string, string>;
    /** When set, the child is spawned detached (its own process group) and
     *  its pid is reported here so a lane can track and later kill the
     *  whole group. */
    onPgid?: (pgid: number) => void;
    /** Grace period before SIGKILL when sweeping the group after a timeout. */
    killGraceMs?: number;
  },
) => Promise<{ stdout: string; stderr: string }>;

interface ChildResult {
  stdout: string;
  stderr: string;
}

/** `node:child_process.exec`'s `detached` option is silently dropped (it
 *  forwards only a fixed allowlist of fields to `spawn`), so a detached
 *  child never leads its own process group there. This reimplements the
 *  same shell-command/timeout/maxBuffer contract directly on `spawn`, which
 *  does honor `detached`, keeping the same resolved/rejected shape
 *  `promisify(exec)` produces (`err.killed`, `err.code`, `err.signal`,
 *  `err.stdout`, `err.stderr`). Only used on the `onPgid` path.
 *
 *  Resolves on the child's own `exit`, not `close`: a command that
 *  backgrounds a grandchild (the exact case this feature exists for, e.g. a
 *  dev server) leaves that grandchild holding the inherited stdout/stderr
 *  pipes open even after the direct child exits, so `close` would never
 *  fire and the promise would hang past its own timeout. The timeout itself
 *  is managed here (not via spawn's built-in `timeout`) so it can kill the
 *  direct child and settle immediately, independent of pipe state. */
function execDetached(
  cmd: string,
  opts: { cwd?: string; timeoutMs?: number; maxBuffer?: number; env?: Record<string, string> },
): Promise<ChildResult> & { child: ReturnType<typeof spawn> } {
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const child = spawn(cmd, {
    shell: true,
    detached: true,
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
  });

  let stdoutLen = 0;
  let stderrLen = 0;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let maxBufferExceeded = false;
  let timedOut = false;

  const timer =
    opts.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, opts.timeoutMs)
      : undefined;

  const promise = new Promise<ChildResult>((resolve, reject) => {
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

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('exit', (code, signal) => {
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');

      if (code === 0 && !signal && !maxBufferExceeded && !timedOut) {
        resolve({ stdout, stderr });
        return;
      }

      const err: any = new Error(
        maxBufferExceeded ? 'stdout/stderr maxBuffer exceeded' : `Command failed: ${cmd}\n${stderr}`,
      );
      err.cmd = cmd;
      err.code = code ?? undefined;
      err.signal = signal ?? undefined;
      err.killed = timedOut || maxBufferExceeded || child.killed;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });

  return Object.assign(promise, { child });
}

/** Sole adapter from the factory's ms-explicit exec options onto node's
 *  child_process `timeout` option (also milliseconds). `opts.env` (e.g. a
 *  lane's leased PORT) is merged over the parent env, never replacing it.
 *  When `opts.onPgid` is set, the child is spawned `detached: true` (leads
 *  its own process group) and, on a timeout/signal rejection, the whole
 *  group is swept via `killProcessGroup` before the original error rethrows —
 *  this catches grandchildren node's built-in timeout can't reach. Without
 *  `onPgid`, behavior is byte-for-byte unchanged from before this option
 *  existed. */
export const defaultExecFn: ExecFn = async (cmd, opts) => {
  if (!opts.onPgid) {
    return exec(cmd, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      maxBuffer: opts.maxBuffer,
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    });
  }

  const child = execDetached(cmd, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    maxBuffer: opts.maxBuffer,
    env: opts.env,
  });

  const pid = child.child.pid;
  if (pid !== undefined) opts.onPgid(pid);

  try {
    return await child;
  } catch (err: any) {
    if ((err?.killed || err?.signal) && pid !== undefined) {
      await killProcessGroup(pid, { graceMs: opts.killGraceMs });
    }
    throw err;
  }
};
