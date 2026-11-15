import { exec as execCb, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';

import { childProcessEnv, redactExecError } from './github-credentials.js';
import { spawnSupervisedCommand } from './supervised-exec.js';
import { killProcessGroup, registerProcessGroup } from '../environment/process-groups.js';

const exec = promisify(execCb);

const DEFAULT_MAX_BUFFER = 1024 * 1024;

export type ExecFn = (
  cmd: string,
  opts: {
    cwd?: string;
    timeoutMs?: number;
    maxBuffer?: number;
    env?: Record<string, string | undefined>;
    onPgid?: (pgid: number) => void;
    onStdout?: (chunk: string) => void;
    killGraceMs?: number;
    githubAuth?: boolean;
  },
) => Promise<{ stdout: string; stderr: string }>;

interface ChildResult {
  stdout: string;
  stderr: string;
}

function execDetached(
  cmd: string,
  opts: {
    cwd?: string;
    timeoutMs?: number;
    maxBuffer?: number;
    env: NodeJS.ProcessEnv;
    onStdout?: (chunk: string) => void;
  },
  spawnFn: typeof spawn,
): Promise<ChildResult> & { child: ReturnType<typeof spawn> } {
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const env = opts.env;
  const ownershipFile = env.FACTORY_DAEMON_GROUPS_FILE;
  const child = ownershipFile
    ? spawnSupervisedCommand(cmd, { cwd: opts.cwd, env, ownershipFile })
    : spawnFn(cmd, { shell: true, detached: true, cwd: opts.cwd, env });
  const deregister = child.pid !== undefined ? registerProcessGroup(child.pid) : () => {};
  child.once('exit', deregister);
  child.once('error', deregister);

  let stdoutLen = 0;
  let stderrLen = 0;
  const stdoutChunks: Buffer[] = [];
  const decoder = new StringDecoder('utf8');
  const stderrChunks: Buffer[] = [];
  let maxBufferExceeded = false;
  let timedOut = false;
  let settled = false;

  const timer =
    opts.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, opts.timeoutMs)
      : undefined;

  const promise = new Promise<ChildResult>((resolve, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutLen += chunk.length;
      if (stdoutLen > maxBuffer) {
        maxBufferExceeded = true;
        child.kill();
        return;
      }
      stdoutChunks.push(chunk);
      if (opts.onStdout) {
        const text = decoder.write(chunk);
        if (text) {
          try {
            opts.onStdout(text);
          } catch {}
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled) return;
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

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
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
    };
    child.on('exit', finish);
    if (ownershipFile)
      child.on('message', (message) => {
        const result = (message as { factoryExit?: { code: number | null; signal: NodeJS.Signals | null } })
          .factoryExit;
        if (result) finish(result.code, result.signal);
      });
  });

  return Object.assign(promise, { child });
}

export interface ExecDeps {
  spawn?: typeof spawn;
  killProcessGroup?: typeof killProcessGroup;
}

export function createDefaultExecFn(deps: ExecDeps = {}): ExecFn {
  const spawnFn = deps.spawn ?? spawn;
  const killGroup = deps.killProcessGroup ?? killProcessGroup;
  return async (cmd, opts) => {
    const env = childProcessEnv(process.env, opts.env, { githubAuth: opts.githubAuth });
    if (!opts.onPgid) {
      try {
        return await exec(cmd, {
          cwd: opts.cwd,
          timeout: opts.timeoutMs,
          maxBuffer: opts.maxBuffer,
          env,
        });
      } catch (err) {
        throw redactExecError(err);
      }
    }

    const child = execDetached(
      cmd,
      {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        maxBuffer: opts.maxBuffer,
        env,
        onStdout: opts.onStdout,
      },
      spawnFn,
    );

    const pid = child.child.pid;
    if (pid !== undefined) opts.onPgid(pid);

    try {
      return await child;
    } catch (err: any) {
      if ((err?.killed || err?.signal) && pid !== undefined) {
        await killGroup(pid, { graceMs: opts.killGraceMs });
      }
      throw redactExecError(err);
    }
  };
}

export const defaultExecFn: ExecFn = createDefaultExecFn();
