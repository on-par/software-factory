// src/harness/opencode.ts — CodingHarness adapter for the OpenCode CLI.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExecFn } from '../utils/exec.js';
import { defaultExecFn } from '../utils/exec.js';
import { shellEscape } from '../utils/index.js';
import { classifyFailure } from './classify.js';
import type { CodingHarness, HarnessFailureReason, HarnessRequest, HarnessResult, HarnessUsage } from './index.js';
import { HarnessError } from './index.js';
import { describeOpenCodeAttempt, type OpenCodeAttemptOutput, writeOpenCodeEmptyTrace } from './opencode-attempt.js';
import { classifyOpenCodeFailure } from './opencode-error.js';
import { type OpenCodeVersionProbe, probeOpenCodeMajor } from './opencode-version.js';
import { defaultClassifyError, type ProviderFailure } from './provider-failure.js';
import { resolveStallSeconds, type StallWatch, type StallWatchOptions, startStallWatch } from './stall-watch.js';

export { describeOpenCodeAttempt };

export type OpenCodeExecFn = ExecFn;

export interface ParsedOpenCodeJson {
  /** Text parts of the last step (after the final `step_start`), trimmed, non-empty, joined by a
   *  blank line; '' when that step has no text. */
  text: string;
  /** Summed `step_finish` usage; undefined when no step reported numeric tokens. `durationMs` is
   *  the span between the smallest and largest finite event `timestamp`, omitted when none. */
  usage?: HarnessUsage;
  /** One line per `error` event, newline-joined; '' when none. Each line is the message (or
   *  error name), then `data.responseBody` when a string, then `status <n>` when
   *  `data.statusCode` is a number, so caps and 429s carried outside the message classify. */
  errorText: string;
  /** `error.type` of the first `error` event with a non-empty string type (#2889); absent when none. */
  errorType?: string;
  /** HTTP status of that same event: first finite number of `error.status`, `error.statusCode`,
   *  `error.data.statusCode`; absent when none. */
  errorStatus?: number;
  /** `tool_use` events whose state error/output says the non-interactive run could not ask for
   *  permission; always present, `[]` when none. */
  permissionDenials: OpenCodePermissionDenial[];
  /** False when a `step_start` has no later `step_finish` (truncated run, #2882); true when every step closed or none started. */
  finished: boolean;
}

export interface OpenCodePermissionDenial {
  /** `part.tool` of the rejected `tool_use`; 'unknown' when absent. */
  tool: string;
  /** First line of the state error/output that carried the rejection, trimmed. */
  message: string;
  /** Denied request from state.input (command/filePath/path/url/pattern) or state.title; first line, ≤200 chars. Absent when none. */
  permission?: string;
}

const PERMISSION_REJECTED = /cannot ask the user for permission/i;
const PERMISSION_INPUT_KEYS = ['command', 'filePath', 'path', 'url', 'pattern'] as const;
const PERMISSION_MAX = 200;

/** The request a rejected `tool_use` asked for, so the error names what was denied (#3025). */
function deniedPermission(state: any): string | undefined {
  const input = state?.input;
  const candidates: unknown[] =
    input && typeof input === 'object' && !Array.isArray(input)
      ? [...PERMISSION_INPUT_KEYS.map((k) => input[k]), state?.title]
      : [state?.title];
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const line = c
      .split('\n')
      .find((l) => l.trim())
      ?.trim();
    if (!line) continue;
    return line.length > PERMISSION_MAX ? `${line.slice(0, PERMISSION_MAX)}…` : line;
  }
  return undefined;
}

/** OpenCode typed `error.type` → failure reason (#2889). Unlisted types fall back to classifyFailure. */
export const OPENCODE_ERROR_TYPE_REASONS: Readonly<Record<string, HarnessFailureReason>> = {
  'provider.rate-limit': 'rate_limit',
  'provider.quota': 'usage_cap',
  'provider.auth': 'local_auth',
  'provider.timeout': 'timeout',
  'provider.connect': 'unavailable',
  'provider.no-route': 'unavailable',
};

export function classifyOpenCodeErrorType(type: string | undefined): HarnessFailureReason | undefined {
  return type !== undefined && Object.hasOwn(OPENCODE_ERROR_TYPE_REASONS, type)
    ? OPENCODE_ERROR_TYPE_REASONS[type]
    : undefined;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Parses `opencode run --format json` NDJSON. Returns undefined when stdout has no
 *  OpenCode event lines (an object with a string `type`), so callers fall back to raw
 *  stdout. Tolerant by design: malformed lines, unknown event types and bad counts are
 *  skipped. Usage capture must never fail a run (#2462). Usage `durationMs` is the span between
 *  the smallest and largest finite event `timestamp` (omitted when none). Only the last step's text is returned:
 *  narration from earlier steps is dropped (#2881). A `tool_use` whose state error/output says the
 *  run cannot ask for permission is reported in `permissionDenials` (#2888). The first `error` event
 *  with a string `error.type` is reported as `errorType`/`errorStatus` (#2889). */
export function parseOpenCodeJson(stdout: string): ParsedOpenCodeJson | undefined {
  let stepTexts: string[] = [];
  const errors: string[] = [];
  let errorType: string | undefined;
  let errorStatus: number | undefined;
  const permissionDenials: OpenCodePermissionDenial[] = [];
  let sawEvent = false;
  let sawUsage = false;
  let openStep = false;
  let numTurns = 0;
  let minTs: number | undefined;
  let maxTs: number | undefined;
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;

  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') continue;
    sawEvent = true;
    const ts = event.timestamp;
    if (typeof ts === 'number' && Number.isFinite(ts)) {
      if (minTs === undefined || ts < minTs) minTs = ts;
      if (maxTs === undefined || ts > maxTs) maxTs = ts;
    }

    if (event.type === 'step_start') {
      stepTexts = [];
      openStep = true;
    } else if (event.type === 'text') {
      const text = event.part?.text;
      if (typeof text === 'string' && text.trim().length > 0) stepTexts.push(text.trim());
    } else if (event.type === 'step_finish') {
      openStep = false;
      const tokens = event.part?.tokens;
      if (!tokens || !Number.isFinite(tokens.input) || !Number.isFinite(tokens.output)) continue;
      sawUsage = true;
      numTurns++;
      input += tokens.input;
      output += tokens.output;
      reasoning += num(tokens.reasoning);
      cacheRead += num(tokens.cache?.read);
      cacheWrite += num(tokens.cache?.write);
      cost += num(event.part?.cost);
    } else if (event.type === 'error') {
      const data = event.error?.data;
      const name = event.error?.name;
      const type = event.error?.type;
      const typed = typeof type === 'string' && type.length > 0;
      const status = [event.error?.status, event.error?.statusCode, data?.statusCode].find(
        (v): v is number => typeof v === 'number' && Number.isFinite(v),
      );
      if (typed && errorType === undefined) {
        errorType = type;
        errorStatus = status;
      }
      const parts: string[] = [];
      if (typeof data?.message === 'string') parts.push(data.message);
      else if (typeof name === 'string') parts.push(name);
      if (typeof data?.responseBody === 'string' && data.responseBody) parts.push(data.responseBody);
      if (parts.length === 0 && typed) parts.push(type);
      if (typeof data?.statusCode === 'number' && Number.isFinite(data.statusCode)) {
        parts.push(`status ${data.statusCode}`);
      } else if (parts.length > 0 && status !== undefined) {
        parts.push(`status ${status}`);
      }
      if (parts.length > 0) errors.push(parts.join(' '));
    } else if (event.type === 'tool_use') {
      const state = event.part?.state;
      const match = [state?.error, state?.output].find(
        (c): c is string => typeof c === 'string' && PERMISSION_REJECTED.test(c),
      );
      if (match !== undefined) {
        const tool = event.part?.tool;
        const line = match.split('\n').find((l) => l.trim()) ?? match;
        const permission = deniedPermission(state);
        permissionDenials.push({
          tool: typeof tool === 'string' && tool ? tool : 'unknown',
          message: line.trim(),
          ...(permission ? { permission } : {}),
        });
      }
    }
  }

  if (!sawEvent) return undefined;
  return {
    text: stepTexts.join('\n\n'),
    errorText: errors.join('\n'),
    permissionDenials,
    ...(errorType !== undefined ? { errorType } : {}),
    ...(errorStatus !== undefined ? { errorStatus } : {}),
    finished: !openStep,
    ...(sawUsage
      ? {
          usage: {
            inputTokens: input + cacheRead + cacheWrite,
            outputTokens: output + reasoning,
            rawInputTokens: input,
            cacheReadTokens: cacheRead,
            cacheCreationTokens: cacheWrite,
            numTurns,
            ...(minTs !== undefined && maxTs !== undefined ? { durationMs: maxTs - minTs } : {}),
            ...(cost > 0 ? { costUsd: cost } : {}),
          },
        }
      : {}),
  };
}

/** `--model`/`--variant` fragment for `opencode run`. v2+ (#2878) carries effort as a `#effort`
 *  model suffix and has no --variant; v1 or an unknown major keeps `--variant`. */
export function buildOpenCodeModelArgs(
  providerModel: string | undefined,
  effort: string | undefined,
  major: number | undefined,
): string {
  if (major !== undefined && major >= 2) {
    if (!providerModel) return '';
    return `--model ${shellEscape(effort === undefined ? providerModel : `${providerModel}#${effort}`)}`;
  }
  const modelArg = providerModel ? `--model ${shellEscape(providerModel)}` : '';
  return `${modelArg}${effort === undefined ? '' : ` --variant ${shellEscape(effort)}`}`;
}

/** Isolation flag for `opencode run`. v2+ (#2879) shares a per-user background server by default;
 *  `--standalone` gives the run a private one. v1 has no such flag, and an unknown major omits it. */
export function buildOpenCodeIsolationArgs(major: number | undefined): string {
  return major !== undefined && major >= 2 ? '--standalone' : '';
}

/** Runs a model via the OpenCode CLI: opencode run --auto --format json [--standalone] (v2+ only) [--model <p/m>[#<effort>]] [--variant <effort>] (v1 only) < prompt-file, executed with cwd = worktree. */
interface OpenCodeExecErrorLike {
  killed?: unknown;
  code?: unknown;
  stderr?: unknown;
  stdout?: unknown;
}

/** stderr plus the parsed stdout error text, newline-joined: the text failures are classified on. */
function openCodeExecClassifyText(err: OpenCodeExecErrorLike): string {
  const parsed = typeof err.stdout === 'string' ? parseOpenCodeJson(err.stdout) : undefined;
  return [typeof err.stderr === 'string' ? err.stderr : '', parsed?.errorText ?? ''].filter(Boolean).join('\n');
}

/** Failure reason of a rejected exec: killed > typed error.type (unless exit 124) > classifyFailure. */
export function openCodeExecFailureReason(err: OpenCodeExecErrorLike): HarnessFailureReason {
  if (err.killed) return 'timeout';
  const parsed = typeof err.stdout === 'string' ? parseOpenCodeJson(err.stdout) : undefined;
  const code = typeof err.code === 'number' ? err.code : 1;
  return (
    (err.code === 124 ? undefined : classifyOpenCodeErrorType(parsed?.errorType)) ??
    classifyFailure(openCodeExecClassifyText(err), code)
  );
}

export class OpenCodeHarness implements CodingHarness {
  readonly id = 'opencode';
  readonly agentic = true;

  private readonly versionProbe: OpenCodeVersionProbe;
  private majorVersion?: Promise<number | undefined>;

  constructor(
    private execFn: OpenCodeExecFn = defaultExecFn,
    versionProbe?: OpenCodeVersionProbe,
    private now: () => number = () => Date.now(),
    private stallWatchOpts: Partial<Omit<StallWatchOptions, 'stallMs' | 'onStall'>> & { stallSeconds?: number } = {},
  ) {
    this.versionProbe = versionProbe ?? (() => probeOpenCodeMajor(this.execFn));
  }

  /** Re-classifies a thrown error; an error this harness already tagged keeps its kind and resetAt. */
  classifyError(err: unknown): ProviderFailure {
    if (err instanceof HarnessError && err.details.kind !== undefined) return defaultClassifyError(err);
    const obj: Record<string, unknown> = typeof err === 'object' && err !== null ? { ...err } : {};
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const details: Record<string, unknown> = err instanceof HarnessError ? err.details : {};
    const text = [
      str(details.diagnostic),
      str(details.stderr),
      str(details.stdout),
      str(obj.stderr),
      openCodeExecClassifyText({ stdout: obj.stdout }),
      err instanceof Error ? err.message : '',
    ]
      .filter(Boolean)
      .join('\n');
    const reason = err instanceof HarnessError ? err.reason : openCodeExecFailureReason(obj);
    return classifyOpenCodeFailure(reason, text, this.now());
  }

  /** Probed once per harness instance; an undefined result is cached too. */
  private getMajorVersion(): Promise<number | undefined> {
    this.majorVersion ??= this.versionProbe().catch(() => undefined);
    return this.majorVersion;
  }

  async run(request: HarnessRequest): Promise<HarnessResult> {
    const { model, prompt, worktree, timeoutSeconds, registry, env, onPgid } = request;
    const effort = registry.getEffort(model, request.task);
    const providerModel = registry.get(model)?.providerModel;
    const effortValue = effort === undefined ? undefined : String(effort);
    const { stallSeconds: stallSecondsOverride, ...watchOpts } = this.stallWatchOpts;
    const stallSeconds = stallSecondsOverride ?? resolveStallSeconds(process.env);
    const major = await this.getMajorVersion();
    const modelArgs = buildOpenCodeModelArgs(providerModel, effortValue, major);
    const isolationArgs = buildOpenCodeIsolationArgs(major);

    // Agentic sessions can legitimately end on a tool call with an empty final
    // message (observed with deepseek-v4-flash on large plan prompts). One
    // retry with an explicit final-message instruction recovers those runs
    // without masking a genuinely broken provider (still throws after 2 tries).
    // It also covers exit-0 runs truncated before the last `step_finish`. When both attempts still
    // come back empty (#694), the diagnostic separates a tool-call-only final step
    // (`finished=true lastFinish=tool-calls earlierTextChars>0`) from truncation (`finished=false`)
    // and from no events at all.
    const FINAL_MESSAGE_NUDGE =
      '\n\nIMPORTANT: your final message must contain your complete answer as plain text. Do not end the session on a tool call or with an empty message.';
    const MAX_ATTEMPTS = 2;

    const promptDir = await mkdtemp(join(tmpdir(), 'factory-opencode-prompt-'));
    const promptPath = join(promptDir, 'prompt.txt');

    try {
      let stdout = '';
      let stderr = '';
      let truncated = false;
      const attempts: OpenCodeAttemptOutput[] = [];
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
        // `--format json` emits NDJSON events so the harness can drop tool chatter
        // and read token usage from `step_finish` events.
        // `--standalone` (v2+ only): v2's run attaches to a shared per-user background
        // server by default; this gives the lane a private one. v1 has no such flag.
        await writeFile(promptPath, attemptPrompt, 'utf8');
        const cmd = `opencode run --auto --format json ${[isolationArgs, modelArgs].filter(Boolean).join(' ')} < ${shellEscape(promptPath)}`;

        // The stall watch needs the child's pgid (detached exec); stdout chunks count as activity.
        let watch: StallWatch | undefined;
        let stalled = false;
        const watched = onPgid !== undefined && stallSeconds > 0;
        try {
          ({ stdout, stderr } = await this.execFn(cmd, {
            cwd: worktree,
            timeoutMs: timeoutSeconds * 1000,
            // JSON `tool_use` events carry full tool output.
            maxBuffer: 64 * 1024 * 1024,
            env,
            onPgid: watched
              ? (pgid) => {
                  onPgid(pgid);
                  watch = startStallWatch(pgid, {
                    ...watchOpts,
                    stallMs: stallSeconds * 1000,
                    onStall: () => {
                      stalled = true;
                    },
                  });
                }
              : onPgid,
            ...(watched ? { onStdout: () => watch?.noteActivity() } : {}),
          }));
        } catch (err: any) {
          if (stalled) {
            throw new HarnessError(
              `opencode run stalled: no CPU, network or output for ${stallSeconds}s (attempt ${attempt}); killed`,
              'timeout',
              {
                exitCode: typeof err.code === 'number' ? err.code : undefined,
                stderr: err.stderr,
                signal: typeof err.signal === 'string' ? err.signal : undefined,
                killed: true,
                stalled: true,
                kind: classifyOpenCodeFailure('timeout', '', this.now()).kind,
              },
            );
          }
          // Under --format json, session errors arrive as stdout `error` events; kept as the diagnostic.
          const parsedErr = typeof err.stdout === 'string' ? parseOpenCodeJson(err.stdout) : undefined;
          const jsonErr = parsedErr?.errorText ?? '';
          const classifyText = [err.stderr ?? '', jsonErr].filter(Boolean).join('\n');
          const reason = openCodeExecFailureReason(err);
          const failure = classifyOpenCodeFailure(reason, classifyText, this.now());
          throw new HarnessError(err.message ?? String(err), reason, {
            exitCode: typeof err.code === 'number' ? err.code : undefined,
            stderr: err.stderr,
            code: typeof err.code === 'string' || typeof err.code === 'number' ? err.code : undefined,
            signal: typeof err.signal === 'string' ? err.signal : undefined,
            killed: err.killed === true ? true : undefined,
            ...(jsonErr ? { diagnostic: jsonErr } : {}),
            kind: failure.kind,
            ...(failure.resetAt ? { resetAt: failure.resetAt } : {}),
          });
        } finally {
          watch?.stop();
        }
        attempts.push({ stdout, stderr });

        const parsed = parseOpenCodeJson(stdout);
        // A non-interactive run auto-rejects `ask` permissions, still exits 0, and the model carries
        // on. The failure is deterministic: no nudge retry, no failover (#2888). The denied request
        // is named alongside the tool (#3025).
        if (parsed && parsed.permissionDenials.length > 0) {
          const label = (d: OpenCodePermissionDenial) => (d.permission ? `${d.tool} (${d.permission})` : d.tool);
          const tools = [...new Set(parsed.permissionDenials.map(label))].join(', ');
          const diagnostic = parsed.permissionDenials.map((d) => `${label(d)}: ${d.message}`).join('\n');
          throw new HarnessError(
            `opencode run auto-rejected a permission request for tool ${tools}: ${parsed.permissionDenials[0].message}`,
            'permission_denied',
            { exitCode: 0, stderr: stderr || undefined, diagnostic },
          );
        }
        const output = parsed ? parsed.text : stdout;
        // An exit-0 run whose last step never got a step_finish is truncated
        // (anomalyco/opencode#50514): fall through to the nudge retry.
        truncated = parsed !== undefined && !parsed.finished;
        if (output.trim().length > 0 && !truncated)
          return { output, ...(parsed?.usage ? { usage: parsed.usage } : {}) };
        if (parsed && parsed.errorText) {
          // OpenCode can exit 0 with the session error only on stdout. Do not
          // nudge-retry into a usage cap or rate limit; let the router fail over.
          const classifyText = [stderr, parsed.errorText].filter(Boolean).join('\n');
          const reason = classifyOpenCodeErrorType(parsed.errorType) ?? classifyFailure(classifyText, 1);
          const failure = classifyOpenCodeFailure(reason, classifyText, this.now());
          throw new HarnessError(`opencode run reported an error event: ${parsed.errorText.split('\n')[0]}`, reason, {
            exitCode: 0,
            stderr: stderr || undefined,
            diagnostic: parsed.errorText,
            kind: failure.kind,
            ...(failure.resetAt ? { resetAt: failure.resetAt } : {}),
          });
        }
      }

      const promptBytes = Buffer.byteLength(prompt);
      const tracePath = await writeOpenCodeEmptyTrace(request.task, model, promptBytes, attempts);
      const diagnostic = [
        `task=${request.task} promptBytes=${promptBytes}`,
        ...attempts.map((a, i) => describeOpenCodeAttempt(i + 1, a.stdout, a.stderr)),
      ].join(' | ');
      throw new HarnessError(
        truncated
          ? `opencode run exited 0 without a final step_finish (${MAX_ATTEMPTS} attempts)`
          : `opencode CLI returned empty output (${MAX_ATTEMPTS} attempts)`,
        'empty_response',
        { exitCode: 0, stderr: stderr || undefined, diagnostic, ...(tracePath ? { tracePath } : {}) },
      );
    } finally {
      await rm(promptDir, { recursive: true, force: true });
    }
  }
}
