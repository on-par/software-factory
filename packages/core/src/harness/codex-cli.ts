// src/harness/codex-cli.ts — CodingHarness adapter for the Codex CLI.

import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { wrapCommandInSandbox } from '../sandbox/index.js';
import type { ExecFn } from '../utils/exec.js';
import { defaultExecFn } from '../utils/exec.js';
import { shellEscape } from '../utils/index.js';
import { classifyFailure } from './classify.js';
import type { CodingHarness, HarnessRequest, HarnessResult, HarnessUsage } from './index.js';
import { HarnessError } from './index.js';

export type CodexExecFn = ExecFn;

/** Runs a model via the Codex CLI:
 *  codex exec --json --sandbox <mode> -c approval_policy=never -C <worktree> [flags] -o <output> - < <prompt> */
export class CodexCliHarness implements CodingHarness {
  readonly id = 'codex-cli';
  readonly agentic = true;

  constructor(private execFn: CodexExecFn = defaultExecFn) {}

  async run(request: HarnessRequest): Promise<HarnessResult> {
    const { model, prompt, worktree, timeoutSeconds, registry, sandbox, env, onPgid } = request;
    const extraFlag = registry.getCodexFlag(model) ?? '';

    const tmpFile = await mktemp(join(tmpdir(), 'factory-codex-'));
    const outFile = await mktemp(join(tmpdir(), 'factory-codex-out-'));
    await writeFile(tmpFile, prompt);

    // With an outer containment sandbox, codex runs workspace-write inside it. Without one,
    // workspace-write is codex's own restriction and blocks legitimate writes, so the run
    // produces a blocked no-op spec instead of an implementation (#834).
    const codexSandbox = sandbox ? 'workspace-write' : 'danger-full-access';
    const cmd = `codex exec --json --sandbox ${codexSandbox} -c approval_policy=never -C ${shellEscape(worktree)} ${extraFlag} -o ${shellEscape(outFile)} - < ${shellEscape(tmpFile)}`;
    const finalCmd = sandbox ? wrapCommandInSandbox(cmd, sandbox) : cmd;

    try {
      let execResult: { stdout: string; stderr: string };
      try {
        execResult = await this.execFn(finalCmd, {
          timeoutMs: timeoutSeconds * 1000,
          maxBuffer: 10 * 1024 * 1024,
          env,
          onPgid,
        });
      } catch (err: any) {
        const stdout = typeof err.stdout === 'string' ? err.stdout : '';
        const errorText = `${err.stderr ?? ''}\n${extractCodexErrorText(stdout)}`;
        const reason = err.killed ? 'timeout' : classifyFailure(errorText, err.code ?? 1);
        throw new HarnessError(err.message ?? String(err), reason, {
          exitCode: typeof err.code === 'number' ? err.code : undefined,
          stderr: err.stderr,
          ...(stdout.length > 0 ? { stdout } : {}),
          code: typeof err.code === 'string' || typeof err.code === 'number' ? err.code : undefined,
          signal: typeof err.signal === 'string' ? err.signal : undefined,
          killed: err.killed === true ? true : undefined,
        });
      }
      assertServedModelMatches(extraFlag, execResult.stderr);
      const output = await readFile(outFile, 'utf-8').catch(() => '');
      if (output.trim().length === 0) {
        throw new HarnessError('codex CLI returned empty output', 'empty_response', { exitCode: 0 });
      }
      const usage = parseCodexUsage(execResult.stdout);
      return { output, ...(usage ? { usage } : {}) };
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

/** Throws if the codex CLI's `model:` banner reports a different model than the one pinned in extraFlag. */
function assertServedModelMatches(extraFlag: string, stderr: string): void {
  const pinnedMatch = extraFlag.match(/(?:^|\s)(?:-m|--model)\s+(\S+)/);
  if (!pinnedMatch) return;
  const servedMatch = stderr.match(/^\s*model:\s*(\S+)/m);
  if (!servedMatch) return;

  const pinned = pinnedMatch[1];
  const served = servedMatch[1];
  if (pinned !== served) {
    throw new HarnessError(`codex CLI served model "${served}" but "${pinned}" was requested`, 'error', {
      exitCode: 0,
      stderr,
    });
  }
}

/** Sums the `turn.completed` usage events codex emits under `--json`. Tolerant by
 *  design: non-JSON lines, a missing usage block, and non-finite counts all resolve
 *  to `undefined`, which the router renders as an `estimated: true` cost row —
 *  usage capture must never fail a run (#425). */
function parseCodexUsage(stdout: string): HarnessUsage | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let sawUsage = false;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const event = parsed as Record<string, unknown>;
    if (event.type !== 'turn.completed') continue;
    const u = event.usage as Record<string, unknown> | undefined;
    if (!u || typeof u !== 'object') continue;
    if (!Number.isFinite(u.input_tokens) || !Number.isFinite(u.output_tokens)) continue;

    sawUsage = true;
    inputTokens += u.input_tokens as number;
    outputTokens += u.output_tokens as number;
    if (Number.isFinite(u.cached_input_tokens)) cacheReadTokens += u.cached_input_tokens as number;
  }

  if (!sawUsage) return undefined;
  return {
    inputTokens,
    outputTokens,
    rawInputTokens: Math.max(0, inputTokens - cacheReadTokens),
    cacheReadTokens,
  };
}

/** Error text codex emits on stdout under `--json`. Only error-bearing events are
 *  included — the agent transcript is excluded so that prose or command output
 *  mentioning a limit cannot manufacture a rate_limit/usage_cap verdict (#425). */
function extractCodexErrorText(stdout: string): string {
  const messages: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const event = parsed as Record<string, unknown>;
    if (event.type === 'error' && typeof event.message === 'string') {
      messages.push(event.message);
    } else if (event.type === 'turn.failed') {
      const err = event.error as Record<string, unknown> | undefined;
      if (err && typeof err.message === 'string') messages.push(err.message);
    } else if (event.type === 'item.completed') {
      const item = event.item as Record<string, unknown> | undefined;
      if (item && item.type === 'error' && typeof item.message === 'string') messages.push(item.message);
    }
  }
  return messages.join('\n');
}
