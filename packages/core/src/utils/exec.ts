// src/utils/exec.ts — Canonical exec seam with an explicit millisecond timeout.

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execCb);

export type ExecFn = (
  cmd: string,
  opts: { cwd?: string; timeoutMs?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

/** Sole adapter from the factory's ms-explicit exec options onto node's
 *  child_process `timeout` option (also milliseconds). */
export const defaultExecFn: ExecFn = (cmd, opts) =>
  exec(cmd, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer });
