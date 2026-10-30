// src/harness/codex-cli.ts — CodingHarness adapter for the Codex CLI.

import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { wrapCommandInSandbox } from '../sandbox/index.js';
import type { ExecFn } from '../utils/exec.js';
import { defaultExecFn } from '../utils/exec.js';
import { shellEscape } from '../utils/index.js';
import { classifyFailure } from './classify.js';
import { classifyCodexFailure, extractCodexErrorText } from './codex-error.js';
import { CODEX_COMPACT_PROMPT, resolveCodexContextCeiling } from './codex-context-ceiling.js';
import { CODEX_GITHUB_HOSTS, CODEX_GITHUB_NETWORK_TASKS, codexWritableRoots } from './codex-policy.js';
import type { CodingHarness, HarnessFailureReason, HarnessRequest, HarnessResult, HarnessUsage } from './index.js';
import { startCodexLiveUsage, CODEX_THREAD_ID, codexThreadIdFromStdout } from './codex-live-usage.js';
import { HarnessError, taskRequiresAgenticHarness } from './index.js';
import { defaultClassifyError, type ProviderFailure } from './provider-failure.js';

const CODEX_LOGIN_HINT = 'codex is not signed in (401): run `codex login`, then retry';

export type CodexExecFn = ExecFn;

export interface CodexRolloutUsage {
  calls: HarnessUsage[];
  numTurns: number;
  peakInputTokens: number;
  contextWindow?: number;
}

/** Read the complete token-count calls visible in one rollout snapshot. */
export async function readCodexRolloutUsage(path: string): Promise<CodexRolloutUsage | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf-8');
  } catch {
    return undefined;
  }
  const calls: HarnessUsage[] = [];
  let peakInputTokens = 0;
  let contextWindow: number | undefined;
  let previousIdentity: string | undefined;
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(value) || value.type !== 'event_msg' || !isRecord(value.payload)) continue;
    const payload = value.payload;
    if (payload.type !== 'token_count' || !isRecord(payload.info)) continue;
    const info = payload.info;
    if (!isRecord(info.last_token_usage) || !isRecord(info.total_token_usage)) continue;
    const last = info.last_token_usage;
    const total = info.total_token_usage;
    if (!isValidCount(last.input_tokens) || !isValidCount(last.output_tokens) || !isValidCount(total.total_tokens))
      continue;
    const identity = JSON.stringify([total.input_tokens, total.output_tokens, total.total_tokens]);
    if (identity === previousIdentity) continue;
    previousIdentity = identity;
    const cached = isValidCount(last.cached_input_tokens) ? last.cached_input_tokens : undefined;
    const inputTokens = last.input_tokens;
    calls.push({
      inputTokens,
      outputTokens: last.output_tokens,
      rawInputTokens: Math.max(0, inputTokens - (cached ?? 0)),
      ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
    });
    peakInputTokens = Math.max(peakInputTokens, inputTokens);
    if (isValidCount(info.model_context_window) && info.model_context_window > 0) {
      contextWindow = info.model_context_window;
    }
  }
  if (calls.length === 0) return undefined;
  return { calls, numTurns: calls.length, peakInputTokens, ...(contextWindow !== undefined ? { contextWindow } : {}) };
}

/** Find the one regular rollout file whose exact suffix names this Codex thread. */
export async function locateCodexRollout(threadId: string, codexHome?: string): Promise<string | undefined> {
  if (!CODEX_THREAD_ID.test(threadId)) return undefined;
  const home = codexHome?.trim() ? codexHome : join(homedir(), '.codex');
  const root = join(home, 'sessions');
  const matches: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${threadId}.jsonl`)) {
        matches.push(path);
      }
    }
  };
  try {
    await walk(root);
  } catch {
    return undefined;
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Injectable temp-file I/O for CodexCliHarness; each field defaults to node:fs/promises. */
export interface CodexFsDeps {
  writeFile?: (path: string, data: string) => Promise<void>;
  readFile?: (path: string, encoding: 'utf-8') => Promise<string>;
  unlink?: (path: string) => Promise<void>;
}

/** Legacy operator request for full access; config must also name the task. */
export const CODEX_FULL_ACCESS_ENV = 'FACTORY_CODEX_FULL_ACCESS';

/** True only when FACTORY_CODEX_FULL_ACCESS is '1' or 'true' (trimmed, case-insensitive). */
export function codexFullAccessOptIn(source: Record<string, string | undefined> = process.env): boolean {
  const value = source[CODEX_FULL_ACCESS_ENV]?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/** Injectable environment and logging for CodexCliHarness. */
export interface CodexHarnessOptions {
  /** Env source for legacy full-access requests; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Line logger; defaults to writing the line to stderr. */
  log?: (line: string) => void;
  /** Poll interval for running usage when a request sets onUsage; default 5000. */
  liveUsageIntervalMs?: number;
  /** Clock for reset times; defaults to Date.now. */
  now?: () => number;
  /** IANA zone for `try again at h:mm`; defaults to the box zone. */
  timeZone?: string;
}

/** Runs a model via the Codex CLI. Full access requires a task named in config:
 *  codex exec --json --sandbox <mode> -c approval_policy=never [network -c flags] -C <worktree> [flags] -o <output> - < <prompt> */
export class CodexCliHarness implements CodingHarness {
  readonly id = 'codex-cli';
  readonly agentic = true;

  private readonly writeFile: (path: string, data: string) => Promise<void>;
  private readonly readFile: (path: string, encoding: 'utf-8') => Promise<string>;
  private readonly unlink: (path: string) => Promise<void>;
  private readonly envSource: Record<string, string | undefined>;
  private readonly log: (line: string) => void;
  private readonly liveUsageIntervalMs: number | undefined;
  private readonly now: () => number;
  private readonly timeZone: string;
  private readonly loggedFullAccess = new Set<string>();
  private loggedLegacyNoEffect = false;
  private readonly loggedRefusals = new Set<string>();
  private readonly loggedWorkspace = new Set<string>();
  private readonly loggedRejectedRoots = new Set<string>();

  constructor(
    private execFn: CodexExecFn = defaultExecFn,
    fs: CodexFsDeps = {},
    options: CodexHarnessOptions = {},
  ) {
    this.envSource = options.env ?? process.env;
    this.liveUsageIntervalMs = options.liveUsageIntervalMs;
    this.now = options.now ?? Date.now;
    this.timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.writeFile = fs.writeFile ?? writeFile;
    this.readFile = fs.readFile ?? readFile;
    this.unlink = fs.unlink ?? unlink;
  }

  /** Re-classifies a thrown error from stderr and codex error events only (#425); a tagged error keeps its kind. */
  classifyError(err: unknown): ProviderFailure {
    if (err instanceof HarnessError && err.details.kind !== undefined) return defaultClassifyError(err);
    const obj: Record<string, unknown> =
      typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
    const details: Record<string, unknown> = err instanceof HarnessError ? err.details : {};
    const parts: unknown[] = [
      details.stderr,
      typeof details.stdout === 'string' ? extractCodexErrorText(details.stdout) : undefined,
      obj.stderr,
      typeof obj.stdout === 'string' ? extractCodexErrorText(obj.stdout) : undefined,
    ];
    const text = parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join('\n');
    let reason: HarnessFailureReason;
    if (err instanceof HarnessError) reason = err.reason;
    else if (obj.killed === true) reason = 'timeout';
    else reason = classifyFailure(text, typeof obj.code === 'number' ? obj.code : 1);
    return classifyCodexFailure(reason, text, this.now(), this.timeZone);
  }

  async run(request: HarnessRequest): Promise<HarnessResult> {
    const { model, prompt, worktree, timeoutSeconds, registry, sandbox, env, onPgid } = request;
    const effort = registry.getEffort(model, request.task);
    const flags = quoteCodexFlags(registry.getCodexFlag(model) ?? '');
    // Codex applies repeated config overrides in order; preserve arbitrary profile flags.
    const extraFlag = effort === undefined ? flags : `${flags} -c ${shellEscape(`model_reasoning_effort=${effort}`)}`;

    let tmpFile: string | undefined;
    let outFile: string | undefined;
    let compactFile: string | undefined;
    try {
      tmpFile = await mktemp(join(tmpdir(), 'factory-codex-'), this.writeFile);
      outFile = await mktemp(join(tmpdir(), 'factory-codex-out-'), this.writeFile);
      await this.writeFile(tmpFile, prompt);

      // Agentic build sessions compact early with a handoff prompt instead of near the full window (#3326).
      const ceiling = resolveCodexContextCeiling(
        request.task,
        request.contextCeiling,
        registry.get(model)?.contextWindow,
      );
      if (taskRequiresAgenticHarness(request.task)) {
        this.log(
          ceiling.on
            ? `codex: context ceiling ${ceiling.limit} for ${request.task}`
            : `codex: context ceiling off (${ceiling.why}) for ${request.task}`,
        );
      }
      let compactFlags = '';
      if (ceiling.on) {
        compactFile = await mktemp(join(tmpdir(), 'factory-codex-compact-'), this.writeFile);
        await this.writeFile(compactFile, CODEX_COMPACT_PROMPT);
        compactFlags = ` -c ${shellEscape(`model_auto_compact_token_limit=${ceiling.limit}`)} -c ${shellEscape(`experimental_compact_prompt_file=${compactFile}`)}`;
      }

      // sandbox.codexSandbox picks Codex's own sandbox; unset means none, like Claude (#3824).
      const workspaceWrite = request.codexSandbox === 'workspace-write';
      const listed = request.codexFullAccessTasks?.includes(request.task) === true;
      const fullAccess = !workspaceWrite || listed;
      if (!workspaceWrite) {
        if (!this.loggedFullAccess.has(request.task)) {
          this.loggedFullAccess.add(request.task);
          this.log(
            request.codexSandbox === undefined
              ? `codex: --sandbox danger-full-access for task ${request.task} (Codex runs without its own sandbox by default; set sandbox.codexSandbox: workspace-write to opt in)`
              : `codex: --sandbox danger-full-access for task ${request.task} (sandbox.codexSandbox: danger-full-access)`,
          );
        }
        const legacyTasks = (request.codexFullAccessTasks?.length ?? 0) > 0;
        const legacyEnv = codexFullAccessOptIn(this.envSource);
        if ((legacyTasks || legacyEnv) && !this.loggedLegacyNoEffect) {
          this.loggedLegacyNoEffect = true;
          this.log(
            'codex: sandbox.codexFullAccessTasks and FACTORY_CODEX_FULL_ACCESS have no effect while full access is the default (sandbox.codexSandbox unset or danger-full-access)',
          );
        }
      } else if (listed && !this.loggedFullAccess.has(request.task)) {
        this.loggedFullAccess.add(request.task);
        this.log(
          `codex: --sandbox danger-full-access for task ${request.task} (config sandbox.codexFullAccessTasks opt-in)`,
        );
      } else if (codexFullAccessOptIn(this.envSource) && !listed && !this.loggedRefusals.has(request.task)) {
        this.loggedRefusals.add(request.task);
        this.log(
          `codex: refused --sandbox danger-full-access for task ${request.task}: not opted in by config (sandbox.codexFullAccessTasks)`,
        );
      }
      const codexSandbox = fullAccess ? 'danger-full-access' : 'workspace-write';
      const { roots, rejected } = codexWritableRoots(request.writableRoots, worktree, request.primaryRepoRoot);
      if (rejected && !this.loggedRejectedRoots.has(request.task)) {
        this.loggedRejectedRoots.add(request.task);
        this.log(`codex: dropped unsafe writable root for task ${request.task}`);
      }
      // gh/push stages get GitHub egress; agentic build stages keep the repo's configured allowlist
      // (registries, #3079); judges and classifiers get no network.
      const githubNetwork = CODEX_GITHUB_NETWORK_TASKS.has(request.task);
      const allowlistNetwork = !githubNetwork && taskRequiresAgenticHarness(request.task) && sandbox !== undefined;
      const network = githubNetwork ? 'github' : allowlistNetwork ? 'allowlist' : 'off';
      const osOwnsNetwork = sandbox?.runtime === 'sandbox-exec' || sandbox?.runtime === 'firejail';
      const networkFlags = fullAccess
        ? ''
        : network === 'off'
          ? ' -c sandbox_workspace_write.network_access=false'
          : osOwnsNetwork
            ? ''
            : ` ${codexNetworkConfigFlags(githubNetwork ? [...(sandbox?.allowHosts ?? []), ...CODEX_GITHUB_HOSTS] : (sandbox?.allowHosts ?? []))}`;
      const rootFlags =
        fullAccess || roots.length === 0
          ? ''
          : ` -c ${shellEscape(`sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`)}`;
      if (!fullAccess && !this.loggedWorkspace.has(request.task)) {
        this.loggedWorkspace.add(request.task);
        this.log(
          `codex: workspace-write for task ${request.task} (network ${network}, writable roots: ${roots.join(', ') || '(none)'})`,
        );
      }
      const cmd = `codex exec --json --sandbox ${codexSandbox} -c approval_policy=never${networkFlags}${rootFlags}${compactFlags} -C ${shellEscape(worktree)} ${extraFlag} -o ${shellEscape(outFile)} - < ${shellEscape(tmpFile)}`;
      const finalCmd = sandbox ? wrapCommandInSandbox(cmd, sandbox) : cmd;

      const selectedHome = env?.CODEX_HOME !== undefined ? env.CODEX_HOME.trim() : this.envSource.CODEX_HOME?.trim();
      const live = request.onUsage
        ? startCodexLiveUsage({
            onUsage: request.onUsage,
            codexHome: selectedHome || undefined,
            intervalMs: this.liveUsageIntervalMs,
            locate: locateCodexRollout,
            read: readCodexRolloutUsage,
          })
        : undefined;
      let execResult: { stdout: string; stderr: string };
      try {
        try {
          execResult = await this.execFn(finalCmd, {
            timeoutMs: timeoutSeconds * 1000,
            maxBuffer: 10 * 1024 * 1024,
            env,
            onPgid,
            ...(live ? { onStdout: live.onStdout } : {}),
          });
        } finally {
          live?.stop();
        }
      } catch (err: any) {
        const stdout = typeof err.stdout === 'string' ? err.stdout : '';
        const errorText = `${err.stderr ?? ''}\n${extractCodexErrorText(stdout)}`;
        const reason = err.killed ? 'timeout' : classifyFailure(errorText, err.code ?? 1);
        const failure = classifyCodexFailure(reason, errorText, this.now(), this.timeZone);
        const tags = { kind: failure.kind, ...(failure.resetAt ? { resetAt: failure.resetAt } : {}) };
        if (reason === 'local_auth') {
          // One actionable line instead of codex's raw 401 JSON (#2494).
          throw new HarnessError(CODEX_LOGIN_HINT, 'local_auth', {
            exitCode: typeof err.code === 'number' ? err.code : undefined,
            ...tags,
          });
        }
        throw new HarnessError(err.message ?? String(err), reason, {
          exitCode: typeof err.code === 'number' ? err.code : undefined,
          stderr: err.stderr,
          ...(stdout.length > 0 ? { stdout } : {}),
          code: typeof err.code === 'string' || typeof err.code === 'number' ? err.code : undefined,
          signal: typeof err.signal === 'string' ? err.signal : undefined,
          killed: err.killed === true ? true : undefined,
          ...tags,
        });
      }
      assertServedModelMatches(extraFlag, execResult.stderr);
      const output = await this.readFile(outFile, 'utf-8').catch(() => '');
      if (output.trim().length === 0) {
        throw new HarnessError('codex CLI returned empty output', 'empty_response', { exitCode: 0 });
      }
      let usage = parseCodexUsage(execResult.stdout);
      if (usage !== undefined) {
        const threadId = codexThreadIdFromStdout(execResult.stdout);
        if (threadId !== undefined) {
          const rolloutPath = await locateCodexRollout(threadId, selectedHome || undefined).catch(() => undefined);
          const rolloutUsage =
            rolloutPath === undefined ? undefined : await readCodexRolloutUsage(rolloutPath).catch(() => undefined);
          if (rolloutUsage !== undefined) {
            usage = {
              ...usage,
              numTurns: rolloutUsage.numTurns,
              peakInputTokens: rolloutUsage.peakInputTokens,
              ...(rolloutUsage.contextWindow !== undefined ? { contextWindow: rolloutUsage.contextWindow } : {}),
            };
          }
        }
      }
      return { output, ...(usage ? { usage } : {}) };
    } finally {
      // Cleanup temp files (remove, don't zero out)
      if (tmpFile !== undefined) await this.unlink(tmpFile).catch(() => {});
      if (outFile !== undefined) await this.unlink(outFile).catch(() => {});
      if (compactFile !== undefined) await this.unlink(compactFile).catch(() => {});
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
