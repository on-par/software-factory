// src/harness/codex-cli.ts — CodingHarness adapter for the Codex CLI.

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodingHarness, HarnessError, HarnessRequest, HarnessResult } from './index.js';
import { classifyFailure } from './classify.js';
import { shellEscape } from '../utils/index.js';

const exec = promisify(execCb);

/** Structurally identical to the router's ExecFn — defined here so the harness
 *  does not import from ../router (avoids an import cycle). */
export type CodexExecFn = (
  cmd: string,
  opts: { cwd?: string; timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

/** Runs a model via the Codex CLI:
 *  codex exec --sandbox workspace-write --ask-for-approval never -C <worktree> [flags] -o <output> - < <prompt> */
export class CodexCliHarness implements CodingHarness {
  readonly id = 'codex-cli';
  readonly agentic = true;

  constructor(private execFn: CodexExecFn = exec) {}

  async run(request: HarnessRequest): Promise<HarnessResult> {
    const { model, prompt, worktree, timeoutSeconds, registry } = request;
    const extraFlag = registry.getCodexFlag(model) ?? '';

    const tmpFile = await mktemp(join(tmpdir(), 'factory-codex-'));
    const outFile = await mktemp(join(tmpdir(), 'factory-codex-out-'));
    await writeFile(tmpFile, prompt);

    const cmd = `codex exec --sandbox workspace-write --ask-for-approval never -C ${shellEscape(worktree)} ${extraFlag} -o ${shellEscape(outFile)} - < ${shellEscape(tmpFile)}`;

    try {
      try {
        await this.execFn(cmd, { timeout: timeoutSeconds * 1000, maxBuffer: 10 * 1024 * 1024 });
      } catch (err: any) {
        const reason = err.killed ? 'timeout' : classifyFailure(err.stderr ?? '', err.code ?? 1);
        throw new HarnessError(err.message ?? String(err), reason, {
          exitCode: typeof err.code === 'number' ? err.code : undefined,
          stderr: err.stderr,
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
