// src/harness/claude-cli.ts — CodingHarness adapter for the Claude CLI.

import type { ExecFn } from '../utils/exec.js';
import { defaultExecFn } from '../utils/exec.js';
import { shellEscape } from '../utils/index.js';
import { classifyFailure } from './classify.js';
import type { CodingHarness, HarnessRequest, HarnessResult } from './index.js';
import { HarnessError } from './index.js';

export type ClaudeExecFn = ExecFn;

/** Runs a model via the Claude CLI:
 *  claude -p <prompt> [--model <claudeFlag>] --dangerously-skip-permissions */
export class ClaudeCliHarness implements CodingHarness {
  readonly id = 'claude-cli';
  readonly agentic = true;

  constructor(private execFn: ClaudeExecFn = defaultExecFn) {}

  async run(request: HarnessRequest): Promise<HarnessResult> {
    const { model, prompt, worktree, timeoutSeconds, registry } = request;
    const flag = registry.getClaudeFlag(model);
    const modelArg = flag ? `--model ${flag}` : '';
    const cmd = `claude -p ${shellEscape(prompt)} ${modelArg} --dangerously-skip-permissions`;

    let stdout: string;
    try {
      ({ stdout } = await this.execFn(cmd, {
        cwd: worktree,
        timeoutMs: timeoutSeconds * 1000,
        maxBuffer: 10 * 1024 * 1024,
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
      throw new HarnessError('claude CLI returned empty output', 'empty_response', { exitCode: 0 });
    }
    return { output: stdout };
  }
}
