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
import type { CodingHarness, HarnessFailureReason, HarnessRequest, HarnessResult, HarnessUsage } from './index.js';
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

/**
 * Failure reason selected by a declaration's `errorPatterns`, or undefined when none match.
 * Patterns are tested case-insensitively (as classifyFailure does), stderr before stdout.
 * Record form: the first matching entry in declaration order returns its key. Array form:
 * the first match is classified by classifyFailure, with 'unknown' mapped to 'error'.
 */
export function matchErrorPattern(
  patterns: HarnessDeclaration['errorPatterns'],
  stderr: string,
  stdout: string,
): HarnessFailureReason | undefined {
  if (!patterns) return undefined;
  const texts = [typeof stderr === 'string' ? stderr : '', typeof stdout === 'string' ? stdout : ''];
  if (Array.isArray(patterns)) {
    for (const source of patterns) {
      const re = new RegExp(source, 'i');
      for (const text of texts) {
        const match = re.exec(text);
        if (match) {
          const reason = classifyFailure(match[0], 1);
          return reason === 'unknown' ? 'error' : reason;
        }
      }
    }
    return undefined;
  }
  for (const [reason, source] of Object.entries(patterns)) {
    const re = new RegExp(source, 'i');
    if (texts.some((text) => re.test(text))) return reason as HarnessFailureReason;
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Sum input_tokens/output_tokens over stdout JSON lines carrying both as finite numbers,
 * top-level or under a `usage` object. Undefined when no line qualifies; never throws.
 */
export function parseJsonlUsage(stdout: string): HarnessUsage | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let found = false;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(obj)) continue;
    const u = isPlainObject(obj.usage) ? obj.usage : obj;
    const input = u.input_tokens;
    const output = u.output_tokens;
    if (typeof input !== 'number' || typeof output !== 'number') continue;
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    inputTokens += input;
    outputTokens += output;
    found = true;
  }
  return found ? { inputTokens, outputTokens } : undefined;
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
        const reason = err.killed
          ? 'timeout'
          : (matchErrorPattern(this.declaration.errorPatterns, err.stderr ?? '', err.stdout ?? '') ??
            classifyFailure(err.stderr ?? '', err.code ?? 1));
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
      const usage = this.declaration.usage === 'jsonl' ? parseJsonlUsage(stdout) : undefined;
      return { output, ...(usage ? { usage } : {}) };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
