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

const CODEX_LOGIN_HINT = 'codex is not signed in (401): run `codex login`, then retry';

export type CodexExecFn = ExecFn;

/** Injectable temp-file I/O for CodexCliHarness; each field defaults to node:fs/promises. */
export interface CodexFsDeps {
  writeFile?: (path: string, data: string) => Promise<void>;
  readFile?: (path: string, encoding: 'utf-8') => Promise<string>;
  unlink?: (path: string) => Promise<void>;
}

/** Operator opt-in for `codex exec --sandbox danger-full-access` (#3080). */
export const CODEX_FULL_ACCESS_ENV = 'FACTORY_CODEX_FULL_ACCESS';

/** True only when FACTORY_CODEX_FULL_ACCESS is '1' or 'true' (trimmed, case-insensitive). */
export function codexFullAccessOptIn(source: Record<string, string | undefined> = process.env): boolean {
  const value = source[CODEX_FULL_ACCESS_ENV]?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/** Injectable environment and logging for CodexCliHarness. */
export interface CodexHarnessOptions {
  /** Env source for the full-access opt-in; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Line logger; defaults to writing the line to stderr. */
  log?: (line: string) => void;
}

/** Runs a model via the Codex CLI. FACTORY_CODEX_FULL_ACCESS=1 forces `--sandbox danger-full-access` with no preflight (#3080):
 *  codex exec --json --sandbox <mode> -c approval_policy=never [network -c flags] -C <worktree> [flags] -o <output> - < <prompt> */
export class CodexCliHarness implements CodingHarness {
  readonly id = 'codex-cli';
  readonly agentic = true;

  private readonly writeFile: (path: string, data: string) => Promise<void>;
  private readonly readFile: (path: string, encoding: 'utf-8') => Promise<string>;
  private readonly unlink: (path: string) => Promise<void>;
  private readonly envSource: Record<string, string | undefined>;
  private readonly log: (line: string) => void;
  private loggedFullAccess = false;

  constructor(
    private execFn: CodexExecFn = defaultExecFn,
    fs: CodexFsDeps = {},
    options: CodexHarnessOptions = {},
  ) {
    this.envSource = options.env ?? process.env;
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.writeFile = fs.writeFile ?? writeFile;
    this.readFile = fs.readFile ?? readFile;
    this.unlink = fs.unlink ?? unlink;
  }

  async run(request: HarnessRequest): Promise<HarnessResult> {
    const { model, prompt, worktree, timeoutSeconds, registry, sandbox, env, onPgid } = request;
    const effort = registry.getEffort(model, request.task);
    const flags = quoteCodexFlags(registry.getCodexFlag(model) ?? '');
    // Codex applies repeated config overrides in order; preserve arbitrary profile flags.
    const extraFlag = effort === undefined ? flags : `${flags} -c ${shellEscape(`model_reasoning_effort=${effort}`)}`;

    const tmpFile = await mktemp(join(tmpdir(), 'factory-codex-'), this.writeFile);
    const outFile = await mktemp(join(tmpdir(), 'factory-codex-out-'), this.writeFile);
    await this.writeFile(tmpFile, prompt);

    // With an outer containment sandbox, codex runs workspace-write inside it. Without one,
    // workspace-write is codex's own restriction and blocks legitimate writes, so the run
    // produces a blocked no-op spec instead of an implementation (#834).
    // The FACTORY_CODEX_FULL_ACCESS opt-in picks danger-full-access on purpose and skips any preflight (#3080).
    const fullAccessOptIn = codexFullAccessOptIn(this.envSource);
    if (fullAccessOptIn && !this.loggedFullAccess) {
      this.loggedFullAccess = true;
      this.log(`codex: --sandbox danger-full-access is on because the operator opted in (${CODEX_FULL_ACCESS_ENV}=1)`);
    }
    const codexSandbox = fullAccessOptIn || !sandbox ? 'danger-full-access' : 'workspace-write';
    // Codex's own sandbox is the containment only when no OS wrapper (sandbox-exec/firejail) runs it;
    // then its network must allow exactly the factory allowlist (#3079).
    const networkFlags =
      !fullAccessOptIn && sandbox && sandbox.runtime !== 'sandbox-exec' && sandbox.runtime !== 'firejail'
        ? ` ${codexNetworkConfigFlags(sandbox.allowHosts)}`
        : '';
    const cmd = `codex exec --json --sandbox ${codexSandbox} -c approval_policy=never${networkFlags} -C ${shellEscape(worktree)} ${extraFlag} -o ${shellEscape(outFile)} - < ${shellEscape(tmpFile)}`;
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
        if (reason === 'local_auth') {
          // One actionable line instead of codex's raw 401 JSON (#2494).
          throw new HarnessError(CODEX_LOGIN_HINT, 'local_auth', {
            exitCode: typeof err.code === 'number' ? err.code : undefined,
          });
        }
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
      const output = await this.readFile(outFile, 'utf-8').catch(() => '');
      if (output.trim().length === 0) {
        throw new HarnessError('codex CLI returned empty output', 'empty_response', { exitCode: 0 });
      }
      const usage = parseCodexUsage(execResult.stdout);
      return { output, ...(usage ? { usage } : {}) };
    } finally {
      // Cleanup temp files (remove, don't zero out)
      await this.unlink(tmpFile).catch(() => {});
      await this.unlink(outFile).catch(() => {});
    }
  }
}

const SAFE_SHELL_WORD = /^[\w@%+=:,./-]+$/;

// Exact DNS name / IPv4, or a `*.suffix` wildcard (subdomains only — same meaning in the factory and Codex).
const CODEX_DOMAIN_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Codex `-c` overrides that let its workspace-write sandbox reach exactly `allowHosts` (#3079).
 *  Hosts are trimmed, lowercased and deduped; anything that is not an exact host or `*.suffix`
 *  (a lone `*`, `**.x`, `host:port`, quotes, blanks) is dropped so the set can never widen.
 *  An empty result keeps Codex's network off. */
export function codexNetworkConfigFlags(allowHosts: readonly string[]): string {
  const hosts = [...new Set(allowHosts.map((h) => h.trim().toLowerCase()).filter((h) => CODEX_DOMAIN_PATTERN.test(h)))];
  if (hosts.length === 0) return '-c sandbox_workspace_write.network_access=false';
  const table = `{${hosts.map((h) => `"${h}"="allow"`).join(',')}}`;
  return `-c sandbox_workspace_write.network_access=true -c features.network_proxy.enabled=true -c ${shellEscape(`features.network_proxy.domains=${table}`)}`;
}

/** Render a configured `codexFlag` string for the codex shell command. The string can come from
 *  the target repo's `.factory/config.yaml`, so it is never spliced in raw (CodeQL #107): it is
 *  split into argv words (whitespace-separated, honouring POSIX single quotes, double quotes and
 *  backslash escapes, with no expansion), and every word that is not plainly safe is re-quoted.
 *  `;`, `$(...)`, backticks and redirects reach codex as literal argument text. Plain flags such
 *  as `-m gpt-5.6-sol -c model_reasoning_effort=high` render byte-identical. */
export function quoteCodexFlags(flags: string): string {
  return splitShellWords(flags)
    .map((word) => (SAFE_SHELL_WORD.test(word) ? word : shellEscape(word)))
    .join(' ');
}

function splitShellWords(input: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < input.length && '"\\$`'.includes(input[i + 1])) word += input[++i];
      else word += ch;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      inWord = true;
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === '\\' && i + 1 < input.length) word += input[++i];
      else word += ch;
    }
  }
  if (quote) throw new HarnessError(`unterminated ${quote} quote in codexFlag: ${input}`, 'error');
  if (inWord) words.push(word);
  return words;
}

async function mktemp(prefix: string, write: (path: string, data: string) => Promise<void>): Promise<string> {
  const path = `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await write(path, '');
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
export function parseCodexUsage(stdout: string): HarnessUsage | undefined {
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
