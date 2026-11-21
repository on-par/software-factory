import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { wrapCommandInSandbox } from '../sandbox/index.js';
import type { ExecFn } from '../utils/exec.js';
import { defaultExecFn } from '../utils/exec.js';
import { COPILOT_TOKEN_ENV } from '../utils/github-credentials.js';
import { shellEscape } from '../utils/index.js';
import { agentEventStdout, copilotActivity } from './agent-events.js';
import { classifyCopilotFailure, COPILOT_CONTAINMENT_HINT, type CopilotFailure } from './copilot-error.js';
import type { CodingHarness, HarnessFailureReason, HarnessRequest, HarnessResult, HarnessUsage } from './index.js';
import { HarnessError } from './index.js';
import { defaultClassifyError, type ProviderFailure } from './provider-failure.js';
import { withTempDir } from './temp-dir.js';

export type CopilotExecFn = ExecFn;

export interface ParsedCopilotJson {
  text: string;
  usage?: HarnessUsage;
  errorText: string;
  exitCode?: number;
  deniedTool: boolean;
}

const CONTAINED_RUNTIMES: ReadonlySet<string> = new Set(['sandbox-exec', 'firejail']);
const DENIED_TOOL = /permission denied and could not request permission/i;
const GENERIC_REASONS: ReadonlySet<HarnessFailureReason> = new Set(['error', 'unknown']);

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function sessionErrorText(data: Record<string, unknown>): string {
  const status = isCount(data.statusCode) ? ` (status ${data.statusCode})` : '';
  return [text(data.errorType), text(data.message)].filter(Boolean).join(': ') + status;
}

function toolErrorText(data: Record<string, unknown>): string {
  return isRecord(data.error) ? text(data.error.message) : text(data.error);
}

function typedEvents(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const candidate of stdout.split('\n').map((raw) => raw.trim())) {
    if (!candidate.startsWith('{')) continue;
    try {
      const value: unknown = JSON.parse(candidate);
      if (isRecord(value) && typeof value.type === 'string') events.push(value);
    } catch {}
  }
  return events;
}

export function parseCopilotJson(stdout: string): ParsedCopilotJson | undefined {
  const events = typedEvents(stdout);
  let finalText = '';
  let exitCode: number | undefined;
  let deniedTool = false;
  const errors: string[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0, sawCacheRead: false, turns: 0 };

  for (const event of events) {
    const data = isRecord(event.data) ? event.data : {};
    if (event.type === 'assistant.message' && !text(data.parentToolCallId)) {
      finalText = text(data.content);
    } else if (event.type === 'assistant.usage' && isCount(data.inputTokens) && isCount(data.outputTokens)) {
      usage.turns++;
      usage.input += data.inputTokens;
      usage.output += data.outputTokens;
      if (isCount(data.cacheReadTokens)) {
        usage.sawCacheRead = true;
        usage.cacheRead += data.cacheReadTokens;
      }
    } else if (event.type === 'session.error') {
      errors.push(sessionErrorText(data));
    } else if (event.type === 'tool.execution_complete' && data.success === false) {
      const message = toolErrorText(data);
      if (DENIED_TOOL.test(message)) deniedTool = true;
    } else if (event.type === 'result' && typeof event.exitCode === 'number') {
      exitCode = event.exitCode;
    }
  }

  if (events.length === 0) return undefined;
  return {
    text: finalText,
    errorText: errors.filter(Boolean).join('\n'),
    deniedTool,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(usage.turns > 0
      ? {
          usage: {
            inputTokens: usage.input,
            outputTokens: usage.output,
            numTurns: usage.turns,
            ...(usage.sawCacheRead ? { cacheReadTokens: usage.cacheRead } : {}),
          },
        }
      : {}),
  };
}

export interface CopilotAllowAllDecision {
  allowAll: boolean;
  why: string;
}

export function copilotAllowAllDecision(
  request: Pick<HarnessRequest, 'sandbox' | 'copilotAllowAll'>,
): CopilotAllowAllDecision {
  const runtime = request.sandbox?.runtime;
  if (runtime !== undefined && CONTAINED_RUNTIMES.has(runtime)) {
    return { allowAll: true, why: `the ${runtime} OS sandbox contains the run` };
  }
  if (request.copilotAllowAll === true) return { allowAll: true, why: 'sandbox.copilotAllowAll: true in config' };
  return {
    allowAll: false,
    why: runtime === undefined ? 'the OS sandbox is off' : `sandbox runtime ${runtime} does not contain the run`,
  };
}

export function buildCopilotCommand(opts: { providerModel?: string; allowAll: boolean; promptPath: string }): string {
  const model = opts.providerModel ? ` --model ${shellEscape(opts.providerModel)}` : '';
  const allowAll = opts.allowAll ? ' --allow-all' : '';
  return `copilot --output-format json --stream off --no-ask-user --no-auto-update --disable-builtin-mcps --secret-env-vars=${COPILOT_TOKEN_ENV}${allowAll}${model} < ${shellEscape(opts.promptPath)}`;
}

export const COPILOT_CHILD_ENV_REMOVALS = [
  'COPILOT_ALLOW_ALL',
  'GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS',
  'GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP',
] as const;

export interface CopilotHarnessOptions {
  log?: (line: string) => void;
}

export class CopilotCliHarness implements CodingHarness {
  readonly id = 'copilot-cli';
  readonly agentic = true;

  private readonly log: (line: string) => void;
  private readonly loggedDecision = new Set<string>();

  constructor(
    private execFn: CopilotExecFn = defaultExecFn,
    options: CopilotHarnessOptions = {},
  ) {
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  }

  classifyError(err: unknown): ProviderFailure {
    if (err instanceof HarnessError && err.details.kind !== undefined) return defaultClassifyError(err);
    const d = (err as { details?: { diagnostic?: unknown; stderr?: unknown } } | null)?.details;
    const parts = [d?.diagnostic, d?.stderr, (err as { message?: unknown } | null)?.message];
    const joined = parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n');
    const exitCode = (err as { details?: { exitCode?: unknown } } | null)?.details?.exitCode;
    return classifyCopilotFailure(joined, typeof exitCode === 'number' ? exitCode : 1);
  }

  async run(request: HarnessRequest): Promise<HarnessResult> {
    const { model, prompt, worktree, timeoutSeconds, registry, sandbox, env, onPgid } = request;
    const decision = copilotAllowAllDecision(request);
    this.logDecision(request.task, decision);
    const childEnv: Record<string, string | undefined> = { ...env };
    for (const name of COPILOT_CHILD_ENV_REMOVALS) childEnv[name] = undefined;

    const stdout = await withTempDir('factory-copilot-prompt-', async (promptDir) => {
      const promptPath = join(promptDir, 'prompt.txt');
      await writeFile(promptPath, prompt, 'utf8');
      const cmd = buildCopilotCommand({
        providerModel: registry.get(model)?.providerModel,
        allowAll: decision.allowAll,
        promptPath,
      });
      try {
        return (
          await this.execFn(sandbox ? wrapCommandInSandbox(cmd, sandbox) : cmd, {
            cwd: worktree,
            timeoutMs: timeoutSeconds * 1000,
            maxBuffer: 64 * 1024 * 1024,
            env: childEnv,
            onPgid,
            onStdout: agentEventStdout(request, copilotActivity),
            copilotAuth: true,
          })
        ).stdout;
      } catch (err: any) {
        throw this.processFailure(err, decision, timeoutSeconds);
      }
    });
    return this.result(stdout, decision);
  }

  private logDecision(task: string, decision: CopilotAllowAllDecision): void {
    if (this.loggedDecision.has(task)) return;
    this.loggedDecision.add(task);
    this.log(
      decision.allowAll
        ? `copilot: --allow-all for task ${task} (${decision.why})`
        : `copilot: no --allow-all for task ${task} (${decision.why}); tool calls that need approval are denied`,
    );
  }

  private processFailure(err: any, decision: CopilotAllowAllDecision, timeoutSeconds: number): HarnessError {
    const stdout = typeof err?.stdout === 'string' && err.stdout.length > 0 ? err.stdout : undefined;
    const stderr = typeof err?.stderr === 'string' ? err.stderr : undefined;
    const exitCode = typeof err?.code === 'number' ? err.code : undefined;
    const base = {
      exitCode,
      stderr,
      stdout,
      code: typeof err?.code === 'string' || typeof err?.code === 'number' ? err.code : undefined,
      signal: typeof err?.signal === 'string' ? err.signal : undefined,
      killed: err?.killed === true ? true : undefined,
    };
    if (err?.killed) {
      return new HarnessError(`copilot CLI was killed after ${timeoutSeconds}s (timeout)`, 'timeout', {
        ...base,
        kind: 'unavailable',
      });
    }
    const parsed = stdout ? parseCopilotJson(stdout) : undefined;
    const diagnostic = [stderr, parsed?.errorText].filter((part) => part && part.trim()).join('\n');
    const failure = this.classify(diagnostic, exitCode ?? 1, parsed, decision);
    const label = `copilot CLI exited${exitCode === undefined ? '' : ` ${exitCode}`}`;
    const why = failure.cause ?? diagnostic.trim().split('\n')[0];
    return new HarnessError(why ? `${label}: ${why}` : label, failure.reason, {
      ...base,
      ...(diagnostic ? { diagnostic } : {}),
      kind: failure.kind,
    });
  }

  private classify(
    diagnostic: string,
    exitCode: number,
    parsed: ParsedCopilotJson | undefined,
    decision: CopilotAllowAllDecision,
  ): CopilotFailure {
    const failure = classifyCopilotFailure(diagnostic, exitCode);
    if (!GENERIC_REASONS.has(failure.reason)) return failure;
    if (parsed?.deniedTool && !decision.allowAll) {
      return { ...failure, reason: 'permission_denied', kind: 'other', cause: COPILOT_CONTAINMENT_HINT };
    }
    if (parsed && parsed.text.trim() === '' && parsed.errorText === '') {
      return { ...failure, reason: 'empty_response', kind: 'unavailable', cause: 'empty final message' };
    }
    return failure;
  }

  private result(stdout: string, decision: CopilotAllowAllDecision): HarnessResult {
    const parsed = parseCopilotJson(stdout);
    if (!parsed) {
      throw new HarnessError(
        stdout.trim() ? 'copilot CLI printed no JSON events' : 'copilot CLI printed no output',
        stdout.trim() ? 'error' : 'empty_response',
        { exitCode: 0, ...(stdout.trim() ? { stdout } : {}) },
      );
    }
    const failedExit = parsed.exitCode !== undefined && parsed.exitCode !== 0;
    if (failedExit || (parsed.errorText && parsed.text.trim() === '')) {
      const failure = this.classify(parsed.errorText, parsed.exitCode ?? 1, parsed, decision);
      const why = failure.cause ?? parsed.errorText.split('\n')[0];
      throw new HarnessError(
        `copilot CLI reported a failed run${parsed.exitCode === undefined ? '' : ` (exit ${parsed.exitCode})`}${why ? `: ${why}` : ''}`,
        failure.reason,
        { exitCode: 0, stdout, ...(parsed.errorText ? { diagnostic: parsed.errorText } : {}), kind: failure.kind },
      );
    }
    if (parsed.text.trim() === '') {
      const denied = parsed.deniedTool && !decision.allowAll;
      throw new HarnessError(
        denied
          ? `copilot CLI returned an empty final message after a denied tool call: ${COPILOT_CONTAINMENT_HINT}`
          : 'copilot CLI returned an empty final message',
        denied ? 'permission_denied' : 'empty_response',
        { exitCode: 0, kind: denied ? 'other' : 'unavailable' },
      );
    }
    return { output: parsed.text, ...(parsed.usage ? { usage: parsed.usage } : {}) };
  }
}
