// src/harness/opencode.ts — CodingHarness adapter for the OpenCode CLI.

import type { ExecFn } from '../utils/exec.js';
import { defaultExecFn } from '../utils/exec.js';
import { shellEscape } from '../utils/index.js';
import { classifyFailure } from './classify.js';
import type { CodingHarness, HarnessRequest, HarnessResult } from './index.js';
import { HarnessError } from './index.js';

export type OpenCodeExecFn = ExecFn;

/** Runs a model via the OpenCode CLI: opencode run [--model <provider/model>] <prompt>, executed with cwd = worktree. */
export class OpenCodeHarness implements CodingHarness {
  readonly id = 'opencode';
  readonly agentic = true;

  constructor(private execFn: OpenCodeExecFn = defaultExecFn) {}

  async run(request: HarnessRequest): Promise<HarnessResult> {
    const { model, prompt, worktree, timeoutSeconds, registry, env, onPgid } = request;
    const providerModel = registry.get(model)?.providerModel;
    const modelArg = providerModel ? `--model ${shellEscape(providerModel)}` : '';
    const cmd = `opencode run ${modelArg} ${shellEscape(prompt)}`;

    let stdout: string;
    try {
      ({ stdout } = await this.execFn(cmd, {
        cwd: worktree,
        timeoutMs: timeoutSeconds * 1000,
        maxBuffer: 10 * 1024 * 1024,
        env,
        onPgid,
      }));
    } catch (err: any) {
      const reason = err.killed ? 'timeout' : classifyFailure(err.stderr ?? '', err.code ?? 1);
      throw new HarnessError(err.message ?? String(err), reason, {
        exitCode: typeof err.code === 'number' ? err.code : undefined,
        stderr: err.stderr,
        code: typeof err.code === 'string' || typeof err.code === 'number' ? err.code : undefined,
        signal: typeof err.signal === 'string' ? err.signal : undefined,
        killed: err.killed === true ? true : undefined,
      });
    }

    if (stdout.trim().length === 0) {
      throw new HarnessError('opencode CLI returned empty output', 'empty_response', { exitCode: 0 });
    }
    return { output: stdout };
  }
}
