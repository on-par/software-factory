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
  text: string;
  usage?: HarnessUsage;
  errorText: string;
  errorType?: string;
  errorStatus?: number;
  permissionDenials: OpenCodePermissionDenial[];
  finished: boolean;
}

export interface OpenCodePermissionDenial {
  tool: string;
  message: string;
  permission?: string;
}

const PERMISSION_REJECTED = /cannot ask the user for permission/i;
const PERMISSION_INPUT_KEYS = ['command', 'filePath', 'path', 'url', 'pattern'] as const;
const PERMISSION_MAX = 200;

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

export function buildOpenCodeIsolationArgs(major: number | undefined): string {
  return major !== undefined && major >= 2 ? '--standalone' : '';
}

interface OpenCodeExecErrorLike {
  killed?: unknown;
  code?: unknown;
  stderr?: unknown;
  stdout?: unknown;
}

function openCodeExecClassifyText(err: OpenCodeExecErrorLike): string {
  const parsed = typeof err.stdout === 'string' ? parseOpenCodeJson(err.stdout) : undefined;
  return [typeof err.stderr === 'string' ? err.stderr : '', parsed?.errorText ?? ''].filter(Boolean).join('\n');
}

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
        await writeFile(promptPath, attemptPrompt, 'utf8');
        const cmd = `opencode run --auto --format json ${[isolationArgs, modelArgs].filter(Boolean).join(' ')} < ${shellEscape(promptPath)}`;

        let watch: StallWatch | undefined;
        let stalled = false;
        const watched = onPgid !== undefined && stallSeconds > 0;
        try {
          ({ stdout, stderr } = await this.execFn(cmd, {
            cwd: worktree,
            timeoutMs: timeoutSeconds * 1000,
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
        truncated = parsed !== undefined && !parsed.finished;
        if (output.trim().length > 0 && !truncated)
          return { output, ...(parsed?.usage ? { usage: parsed.usage } : {}) };
        if (parsed && parsed.errorText) {
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
