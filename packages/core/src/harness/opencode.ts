// src/harness/opencode.ts — CodingHarness adapter for the OpenCode CLI.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExecFn } from '../utils/exec.js';
import { defaultExecFn } from '../utils/exec.js';
import { shellEscape } from '../utils/index.js';
import { classifyFailure } from './classify.js';
import type { CodingHarness, HarnessRequest, HarnessResult } from './index.js';
import { HarnessError } from './index.js';

export type OpenCodeExecFn = ExecFn;

/** Runs a model via the OpenCode CLI: opencode run --auto [--model <provider/model>] [--variant <effort>] < prompt-file, executed with cwd = worktree. */
export class OpenCodeHarness implements CodingHarness {
  readonly id = 'opencode';
  readonly agentic = true;

  constructor(private execFn: OpenCodeExecFn = defaultExecFn) {}

  async run(request: HarnessRequest): Promise<HarnessResult> {
    const { model, prompt, worktree, timeoutSeconds, registry, env, onPgid } = request;
    const effort = registry.getEffort(model, request.task);
    const effortArg = effort === undefined ? '' : ` --variant ${shellEscape(String(effort))}`;
    const providerModel = registry.get(model)?.providerModel;
    const modelArg = providerModel ? `--model ${shellEscape(providerModel)}` : '';

    // Agentic sessions can legitimately end on a tool call with an empty final
    // message (observed with deepseek-v4-flash on large plan prompts). One
    // retry with an explicit final-message instruction recovers those runs
    // without masking a genuinely broken provider (still throws after 2 tries).
    const FINAL_MESSAGE_NUDGE =
      '\n\nIMPORTANT: your final message must contain your complete answer as plain text. Do not end the session on a tool call or with an empty message.';
    const MAX_ATTEMPTS = 2;

    const promptDir = await mkdtemp(join(tmpdir(), 'factory-opencode-prompt-'));
    const promptPath = join(promptDir, 'prompt.txt');

    try {
      let stdout = '';
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const attemptPrompt = attempt === 1 ? prompt : prompt + FINAL_MESSAGE_NUDGE;
        // `--auto`: headless runs auto-REJECT permission prompts (e.g. reading the
        // frozen spec in .factory/plans/, which is outside the worktree), killing
        // the session with an empty final message. Auto-approve matches the risk
        // model of the other engines (claude --dangerously-skip-permissions,
        // codex --yolo): the factory owns the worktree and reviews the diff.
        // `< promptPath`: opencode run reads a non-TTY stdin as the message. This
        // keeps the prompt out of argv so large prompts don't hit ARG_MAX/E2BIG,
        // and a file redirect still closes stdin at EOF: opencode run otherwise
        // blocks on a pipe stdin (execDetached never closes child.stdin), hanging
        // every call until the phase timeout.
        await writeFile(promptPath, attemptPrompt, 'utf8');
        const cmd = `opencode run --auto ${modelArg}${effortArg} < ${shellEscape(promptPath)}`;

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

        if (stdout.trim().length > 0) return { output: stdout };
      }

      throw new HarnessError(`opencode CLI returned empty output (${MAX_ATTEMPTS} attempts)`, 'empty_response', {
        exitCode: 0,
      });
    } finally {
      await rm(promptDir, { recursive: true, force: true });
    }
  }
}
