// src/harness/opencode.ts — CodingHarness adapter for the OpenCode CLI.

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { CodingHarness, HarnessError, HarnessRequest, HarnessResult } from './index.js';
import { classifyFailure } from './classify.js';
import { shellEscape } from '../utils/index.js';

const exec = promisify(execCb);

/** Structurally identical to the router's ExecFn — defined here so the harness
 *  does not import from ../router (avoids an import cycle). */
export type OpenCodeExecFn = (
  cmd: string,
  opts: { cwd?: string; timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

/** Runs a model via the OpenCode CLI: opencode run [--model <provider/model>] <prompt>, executed with cwd = worktree. */
export class OpenCodeHarness implements CodingHarness {
  readonly id = 'opencode';
  readonly agentic = true;

  constructor(private execFn: OpenCodeExecFn = exec) {}

  async run(request: HarnessRequest): Promise<HarnessResult> {
    const { model, prompt, worktree, timeoutSeconds, registry } = request;
    const providerModel = registry.get(model)?.providerModel;
    const modelArg = providerModel ? `--model ${shellEscape(providerModel)}` : '';
    const cmd = `opencode run ${modelArg} ${shellEscape(prompt)}`;

    let stdout: string;
    try {
      ({ stdout } = await this.execFn(cmd, {
        cwd: worktree,
        timeout: timeoutSeconds * 1000,
        maxBuffer: 10 * 1024 * 1024,
      }));
    } catch (err: any) {
      const reason = err.killed ? 'timeout' : classifyFailure(err.stderr ?? '', err.code ?? 1);
      throw new HarnessError(err.message ?? String(err), reason, {
        exitCode: typeof err.code === 'number' ? err.code : undefined,
        stderr: err.stderr,
      });
    }

    if (stdout.trim().length === 0) {
      throw new HarnessError('opencode CLI returned empty output', 'empty_response', { exitCode: 0 });
    }
    return { output: stdout };
  }
}
