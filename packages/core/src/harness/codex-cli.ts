// src/harness/codex-cli.ts — CodingHarness adapter for the Codex CLI.

import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { wrapCommandInSandbox } from '../sandbox/index.js';
import type { ExecFn } from '../utils/exec.js';
import { defaultExecFn } from '../utils/exec.js';
import { shellEscape } from '../utils/index.js';
import { classifyFailure } from './classify.js';
import type { CodingHarness, HarnessRequest, HarnessResult } from './index.js';
import { HarnessError } from './index.js';

export type CodexExecFn = ExecFn;

/** Runs a model via the Codex CLI:
 *  codex exec --sandbox workspace-write -c approval_policy=never -C <worktree> [flags] -o <output> - < <prompt> */
export class CodexCliHarness implements CodingHarness {
  readonly id = 'codex-cli';
  readonly agentic = true;

  constructor(private execFn: CodexExecFn = defaultExecFn) {}

  async run(request: HarnessRequest): Promise<HarnessResult> {
    const { model, prompt, worktree, timeoutSeconds, registry, sandbox } = request;
    const extraFlag = registry.getCodexFlag(model) ?? '';

    const tmpFile = await mktemp(join(tmpdir(), 'factory-codex-'));
    const outFile = await mktemp(join(tmpdir(), 'factory-codex-out-'));
    await writeFile(tmpFile, prompt);

    const cmd = `codex exec --sandbox workspace-write -c approval_policy=never -C ${shellEscape(worktree)} ${extraFlag} -o ${shellEscape(outFile)} - < ${shellEscape(tmpFile)}`;
    const finalCmd = sandbox ? wrapCommandInSandbox(cmd, sandbox) : cmd;

    try {
      try {
        await this.execFn(finalCmd, { timeoutMs: timeoutSeconds * 1000, maxBuffer: 10 * 1024 * 1024 });
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
      const output = await readFile(outFile, 'utf-8').catch(() => '');
      if (output.trim().length === 0) {
        throw new HarnessError('codex CLI returned empty output', 'empty_response', { exitCode: 0 });
      }
      return { output };
    } finally {
      // Cleanup temp files (remove, don't zero out)
      await unlink(tmpFile).catch(() => {});
      await unlink(outFile).catch(() => {});
    }
  }
}

async function mktemp(prefix: string): Promise<string> {
  const path = `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(path, '');
  return path;
}
