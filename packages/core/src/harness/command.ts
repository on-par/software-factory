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
import { failureKindFor } from './provider-failure.js';

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

function resetAtFromMatch(match: RegExpExecArray): string | undefined {
  const captured = match.groups?.reset;
  if (!captured) return undefined;
  const ms = Date.parse(captured);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function matchErrorPatternFailure(
  patterns: HarnessDeclaration['errorPatterns'],
  stderr: string,
  stdout: string,
): { reason: HarnessFailureReason; resetAt?: string } | undefined {
  if (!patterns) return undefined;
  const texts = [typeof stderr === 'string' ? stderr : '', typeof stdout === 'string' ? stdout : ''];
  if (Array.isArray(patterns)) {
    for (const source of patterns) {
      const re = new RegExp(source, 'i');
      for (const text of texts) {
        const match = re.exec(text);
        if (match) {
          const classified = classifyFailure(match[0], 1);
          const resetAt = resetAtFromMatch(match);
          return { reason: classified === 'unknown' ? 'error' : classified, ...(resetAt ? { resetAt } : {}) };
        }
      }
    }
    return undefined;
  }
  for (const [reason, source] of Object.entries(patterns)) {
    const re = new RegExp(source, 'i');
    for (const text of texts) {
      const match = re.exec(text);
      if (match) {
        const resetAt = resetAtFromMatch(match);
        return { reason: reason as HarnessFailureReason, ...(resetAt ? { resetAt } : {}) };
      }
    }
  }
  return undefined;
}

export function matchErrorPattern(
  patterns: HarnessDeclaration['errorPatterns'],
  stderr: string,
  stdout: string,
): HarnessFailureReason | undefined {
  return matchErrorPatternFailure(patterns, stderr, stdout)?.reason;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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
        const matched = err.killed
          ? undefined
          : matchErrorPatternFailure(this.declaration.errorPatterns, err.stderr ?? '', err.stdout ?? '');
        const reason: HarnessFailureReason = err.killed
          ? 'timeout'
          : (matched?.reason ?? classifyFailure(err.stderr ?? '', err.code ?? 1));
        throw new HarnessError(err.message ?? String(err), reason, {
          exitCode: typeof err.code === 'number' ? err.code : undefined,
          stderr: err.stderr,
          stdout: err.stdout,
          code: typeof err.code === 'string' || typeof err.code === 'number' ? err.code : undefined,
          signal: typeof err.signal === 'string' ? err.signal : undefined,
          killed: err.killed === true ? true : undefined,
          kind: failureKindFor(reason, `${err.message ?? ''} ${err.stderr ?? ''}`),
          ...(matched?.resetAt ? { resetAt: matched.resetAt } : {}),
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
