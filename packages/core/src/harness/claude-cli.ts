// src/harness/claude-cli.ts — CodingHarness adapter for the Claude CLI.

import { wrapCommandInSandbox } from '../sandbox/index.js';
import type { ExecFn } from '../utils/exec.js';
import { defaultExecFn } from '../utils/exec.js';
import { shellEscape } from '../utils/index.js';
import { classifyFailure } from './classify.js';
import type { CodingHarness, HarnessRequest, HarnessResult, HarnessUsage } from './index.js';
import { HarnessError } from './index.js';

export type ClaudeExecFn = ExecFn;

/** Parses the `claude -p --output-format json` result envelope. Falls back to
 *  raw stdout as output when it isn't the expected JSON shape — usage capture
 *  must never cause a run to fail. */
function parseResultEnvelope(stdout: string): { output: string; usage?: HarnessUsage } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return { output: stdout };
  }
  if (typeof parsed !== 'object' || parsed === null) return { output: stdout };
  const env = parsed as Record<string, unknown>;
  if (env.type !== 'result' || typeof env.result !== 'string') return { output: stdout };

  let usage: HarnessUsage | undefined;
  const u = env.usage as Record<string, unknown> | undefined;
  if (u && typeof u === 'object' && Number.isFinite(u.input_tokens) && Number.isFinite(u.output_tokens)) {
    const cacheCreation = Number.isFinite(u.cache_creation_input_tokens)
      ? (u.cache_creation_input_tokens as number)
      : 0;
    const cacheRead = Number.isFinite(u.cache_read_input_tokens) ? (u.cache_read_input_tokens as number) : 0;
    const costUsd = Number.isFinite(env.total_cost_usd)
      ? (env.total_cost_usd as number)
      : Number.isFinite(env.cost_usd)
        ? (env.cost_usd as number)
        : undefined;
    usage = {
      inputTokens: (u.input_tokens as number) + cacheCreation + cacheRead,
      outputTokens: u.output_tokens as number,
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
  }
  return { output: env.result, usage };
}

/** Runs a model via the Claude CLI:
 *  claude -p <prompt> [--model <claudeFlag>] --output-format json --dangerously-skip-permissions */
export class ClaudeCliHarness implements CodingHarness {
  readonly id = 'claude-cli';
  readonly agentic = true;

  constructor(private execFn: ClaudeExecFn = defaultExecFn) {}

  async run(request: HarnessRequest): Promise<HarnessResult> {
    const { model, prompt, worktree, timeoutSeconds, registry, sandbox, env, onPgid } = request;
    const flag = registry.getClaudeFlag(model);
    const modelArg = flag ? `--model ${flag}` : '';
    const cmd = `claude -p ${shellEscape(prompt)} ${modelArg} --output-format json --dangerously-skip-permissions < /dev/null`;
    const finalCmd = sandbox ? wrapCommandInSandbox(cmd, sandbox) : cmd;

    let stdout: string;
    try {
      ({ stdout } = await this.execFn(finalCmd, {
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
        stdout: typeof err.stdout === 'string' && err.stdout.length > 0 ? err.stdout : undefined,
        code: typeof err.code === 'string' || typeof err.code === 'number' ? err.code : undefined,
        signal: typeof err.signal === 'string' ? err.signal : undefined,
        killed: err.killed === true ? true : undefined,
      });
    }

    const { output, usage } = parseResultEnvelope(stdout);
    if (output.trim().length === 0) {
      throw new HarnessError('claude CLI returned empty output', 'empty_response', { exitCode: 0 });
    }
    return { output, ...(usage ? { usage } : {}) };
  }
}
