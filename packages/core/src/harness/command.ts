// src/harness/command.ts — generic CodingHarness for user-declared `harnesses:` entries.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HarnessDeclaration } from '../config/index.js';
import { wrapCommandInSandbox } from '../sandbox/index.js';
import type { ExecFn } from '../utils/exec.js';
import { defaultExecFn } from '../utils/exec.js';
import { shellEscape } from '../utils/index.js';
import { classifyFailure } from './classify.js';
import type { CodingHarness, HarnessRequest, HarnessResult } from './index.js';
import { HarnessError } from './index.js';

/**
 * Substitute {model}, {worktree} and {outFile} in a declared command template with
 * shell-escaped values. Single pass, so a substituted value is never re-scanned.
 * Unknown placeholders, and {outFile} without a value, stay literal. Placeholders
 * must appear unquoted in the template: this function supplies the quoting.
 */
export function buildHarnessCommand(
  template: string,
  values: { model: string; worktree: string; outFile?: string },
): string {
  return template.replace(/\{(model|worktree|outFile)\}/g, (match, key: 'model' | 'worktree' | 'outFile') => {
    const value = values[key];
    return value === undefined ? match : shellEscape(value);
  });
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Text of the last JSON-object line on stdout that carries a message; '' when none does. */
export function extractJsonlLastMessage(stdout: string): string {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) continue;
    const parts = Array.isArray(obj.message?.content)
      ? obj.message.content
          .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
          .map((part: any) => part.text)
          .join('\n')
      : undefined;
    const found =
      nonEmptyString(obj.text) ??
      nonEmptyString(obj.result) ??
      nonEmptyString(obj.message) ??
      nonEmptyString(obj.content) ??
      nonEmptyString(obj.item?.text) ??
      nonEmptyString(parts);
    if (found) return found;
  }
  return '';
}

/** Runs a user-declared agent CLI (models config `harnesses:`) with cwd = worktree. */
export class CommandHarness implements CodingHarness {
  readonly agentic: boolean;

  constructor(
    readonly id: string,
    private declaration: HarnessDeclaration,
    private execFn: ExecFn = defaultExecFn,
  ) {
    this.agentic = declaration.agentic;
  }

  async run(request: HarnessRequest): Promise<HarnessResult> {
    const { model, prompt, worktree, timeoutSeconds, registry, sandbox, env, onPgid } = request;
    const dir = await mkdtemp(join(tmpdir(), 'factory-command-'));
    try {
      const promptPath = join(dir, 'prompt.txt');
      await writeFile(promptPath, prompt, 'utf8');
      const outFile = this.declaration.output === 'file:{outFile}' ? join(dir, 'out.txt') : undefined;
      const base = buildHarnessCommand(this.declaration.command, {
        model: registry.getProviderModel(model),
        worktree,
        outFile,
      });
      // `< /dev/null` closes stdin (execDetached never closes the pipe; see opencode.ts).
      const cmd =
        this.declaration.prompt === 'arg'
          ? `${base} ${shellEscape(prompt)} < /dev/null`
          : this.declaration.prompt === 'file'
            ? `${base} ${shellEscape(promptPath)} < /dev/null`
            : `${base} < ${shellEscape(promptPath)}`;
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
          stdout: err.stdout,
          code: typeof err.code === 'string' || typeof err.code === 'number' ? err.code : undefined,
          signal: typeof err.signal === 'string' ? err.signal : undefined,
          killed: err.killed === true ? true : undefined,
        });
      }

      const output =
        this.declaration.output === 'stdout'
          ? stdout
          : outFile !== undefined
            ? await readFile(outFile, 'utf8').catch(() => '')
            : extractJsonlLastMessage(stdout);
      if (output.trim().length === 0) {
        throw new HarnessError(`${this.id} command returned empty output`, 'empty_response', { exitCode: 0 });
      }
      return { output };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
