// src/harness/claude-cli.ts — CodingHarness adapter for the Claude CLI.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
 *  must never cause a run to fail. `isError`/`subtype` surface the CLI's own
 *  error signal (e.g. max-turns exceeded) so a truncated error response isn't
 *  mistaken for a completed result (#424 code review). */
function parseResultEnvelope(stdout: string): {
  output: string;
  usage?: HarnessUsage;
  isError?: boolean;
  subtype?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    const resultLine = stdout
      .trim()
      .split('\n')
      .reverse()
      .find((line) => {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          return event.type === 'result' && typeof event.result === 'string';
        } catch {
          return false;
        }
      });
    if (!resultLine) return { output: stdout };
    parsed = JSON.parse(resultLine);
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
    const numTurns = Number.isFinite(env.num_turns) ? (env.num_turns as number) : undefined;
    const durationMs = Number.isFinite(env.duration_ms) ? (env.duration_ms as number) : undefined;
    const durationApiMs = Number.isFinite(env.duration_api_ms) ? (env.duration_api_ms as number) : undefined;
    usage = {
      inputTokens: (u.input_tokens as number) + cacheCreation + cacheRead,
      outputTokens: u.output_tokens as number,
      rawInputTokens: u.input_tokens as number,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      ...(numTurns !== undefined ? { numTurns } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(durationApiMs !== undefined ? { durationApiMs } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
  }
  return {
    output: env.result,
    usage,
    isError: env.is_error === true,
    subtype: typeof env.subtype === 'string' ? env.subtype : undefined,
  };
}

function extractFailureDiagnosticFromStream(stdout: string): string | undefined {
  const diagnostics: string[] = [];
  let sawJsonLine = false;
  for (const line of stdout.trim().split('\n')) {
    if (line.trim().length === 0) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
      sawJsonLine = true;
    } catch {
      if (!sawJsonLine) diagnostics.push(line);
      continue;
    }
    if (event.type !== 'result') continue;
    if (typeof event.subtype === 'string') diagnostics.push(event.subtype);
    if (typeof event.api_error_status === 'string') diagnostics.push(event.api_error_status);
    if (typeof event.terminal_reason === 'string') diagnostics.push(event.terminal_reason);
    if (typeof event.result === 'string') diagnostics.push(event.result);
  }
  return diagnostics.length > 0 ? diagnostics.join('\n') : sawJsonLine ? '' : undefined;
}

/** Runs a model via the Claude CLI:
 *  claude -p [--model <claudeFlag>] --output-format stream-json --verbose --safe-mode --permission-mode bypassPermissions < prompt-file */
export class ClaudeCliHarness implements CodingHarness {
  readonly id = 'claude-cli';
  readonly agentic = true;

  constructor(private execFn: ClaudeExecFn = defaultExecFn) {}

  async run(request: HarnessRequest): Promise<HarnessResult> {
    const { model, prompt, worktree, timeoutSeconds, registry, sandbox, env, onPgid } = request;
    const flag = registry.getClaudeFlag(model);
    const modelArg = flag ? `--model ${flag}` : '';
    const promptDir = await mkdtemp(join(tmpdir(), 'factory-claude-prompt-'));
    const promptPath = join(promptDir, 'prompt.txt');
    await writeFile(promptPath, prompt, 'utf8');
    const cmd = `claude -p ${modelArg} --output-format stream-json --include-partial-messages --verbose --safe-mode --permission-mode bypassPermissions < ${shellEscape(promptPath)}`;
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
      const stdout = typeof err.stdout === 'string' && err.stdout.length > 0 ? err.stdout : undefined;
      const stdoutDiagnostic = stdout ? extractFailureDiagnosticFromStream(stdout) : undefined;
      const diagnosticText = [err.stderr, stdoutDiagnostic ?? stdout]
        .filter((text) => typeof text === 'string')
        .join('\n');
      const reason = err.killed ? 'timeout' : classifyFailure(diagnosticText, err.code ?? 1);
      throw new HarnessError(err.message ?? String(err), reason, {
        exitCode: typeof err.code === 'number' ? err.code : undefined,
        stderr: err.stderr,
        stdout,
        code: typeof err.code === 'string' || typeof err.code === 'number' ? err.code : undefined,
        signal: typeof err.signal === 'string' ? err.signal : undefined,
        killed: err.killed === true ? true : undefined,
      });
    } finally {
      await rm(promptDir, { recursive: true, force: true });
    }

    const { output, usage, isError, subtype } = parseResultEnvelope(stdout);
    if (isError) {
      const unavailable = usage?.inputTokens === 0 && usage.outputTokens === 0 && usage.durationApiMs === 0;
      throw new HarnessError(
        unavailable
          ? 'claude CLI returned a zero-token, zero-API-duration error result — provider unavailable'
          : `claude CLI returned an error result${subtype ? ` (${subtype})` : ''}`,
        unavailable ? 'unavailable' : 'error',
        {
          exitCode: 0,
          stdout: output,
        },
      );
    }
    if (output.trim().length === 0) {
      throw new HarnessError('claude CLI returned empty output', 'empty_response', { exitCode: 0 });
    }
    if (/^Unknown command:/i.test(output.trim())) {
      throw new HarnessError('claude CLI returned an unknown command response', 'error', {
        exitCode: 0,
        stdout: output,
      });
    }
    return { output, ...(usage ? { usage } : {}) };
  }
}
