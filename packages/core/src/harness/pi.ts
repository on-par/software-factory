import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { wrapCommandInSandbox } from '../sandbox/index.js';
import type { ExecFn } from '../utils/exec.js';
import { defaultExecFn } from '../utils/exec.js';
import { shellEscape } from '../utils/index.js';
import { classifyFailure } from './classify.js';
import type { CodingHarness, HarnessFailureReason, HarnessRequest, HarnessResult, HarnessUsage } from './index.js';
import { HarnessError } from './index.js';

export type PiExecFn = ExecFn;

export interface ParsedPiJson {
  text: string;
  usage?: HarnessUsage;
  lastStopReason?: string;
  aborted?: boolean;
  errorText: string;
}

const PI_PROVIDER_REASONS = new Set<HarnessFailureReason>(['rate_limit', 'usage_cap', 'local_auth']);

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function parsePiJson(stdout: string): ParsedPiJson | undefined {
  let lastText = '';
  let lastStopReason: string | undefined;
  let aborted: boolean | undefined;
  const errors: string[] = [];
  let sawEvent = false;
  let sawUsage = false;
  let numTurns = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;

  for (const raw of stdout.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') continue;
    sawEvent = true;

    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const message = event.message;
      const content: unknown[] = Array.isArray(message.content) ? message.content : [];
      lastText = content
        .map((part: any) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
        .join('');
      lastStopReason = typeof message.stopReason === 'string' ? message.stopReason : undefined;
      if (typeof message.errorMessage === 'string' && message.errorMessage.trim()) errors.push(message.errorMessage);
      const usage = message.usage;
      if (usage && Number.isFinite(usage.input) && Number.isFinite(usage.output)) {
        sawUsage = true;
        numTurns++;
        input += usage.input;
        output += usage.output;
        cacheRead += num(usage.cacheRead);
        cacheWrite += num(usage.cacheWrite);
        cost += num(usage.cost?.total);
      }
    } else if (event.type === 'agent_settled') {
      aborted = typeof event.aborted === 'boolean' ? event.aborted : undefined;
    } else if (event.type === 'auto_retry_end' && typeof event.finalError === 'string' && event.finalError.trim()) {
      errors.push(event.finalError);
    } else if (event.type === 'compaction_end' && typeof event.errorMessage === 'string' && event.errorMessage.trim()) {
      errors.push(event.errorMessage);
    }
  }

  if (!sawEvent) return undefined;
  return {
    text: lastText,
    lastStopReason,
    aborted,
    errorText: errors.join('\n'),
    ...(sawUsage
      ? {
          usage: {
            inputTokens: input + cacheRead + cacheWrite,
            outputTokens: output,
            rawInputTokens: input,
            cacheReadTokens: cacheRead,
            cacheCreationTokens: cacheWrite,
            numTurns,
            ...(cost > 0 ? { costUsd: cost } : {}),
          },
        }
      : {}),
  };
}

export function buildPiCommand(providerModel: string | undefined, promptPath: string, effort?: string): string {
  const slash = providerModel?.indexOf('/') ?? -1;
  if (!providerModel || slash <= 0 || slash === providerModel.length - 1) {
    throw new HarnessError(
      `pi harness needs providerModel '<provider>/<model>' (got '${providerModel ?? ''}')`,
      'error',
    );
  }
  const provider = providerModel.slice(0, slash);
  const id = providerModel.slice(slash + 1);
  const thinkingArg = effort === undefined ? '' : ` --thinking ${shellEscape(effort === 'none' ? 'off' : effort)}`;
  return `pi -p --mode json --no-session --no-context-files --no-extensions --no-skills --no-prompt-templates --no-mcp --no-approve --offline --provider ${shellEscape(provider)} --model ${shellEscape(id)}${thinkingArg} < ${shellEscape(promptPath)}`;
}

export class PiHarness implements CodingHarness {
  readonly id = 'pi';
  readonly agentic = true;

  constructor(private execFn: PiExecFn = defaultExecFn) {}

  async run(request: HarnessRequest): Promise<HarnessResult> {
    const { model, prompt, worktree, timeoutSeconds, registry, sandbox, env, onPgid } = request;
    const providerModel = registry.get(model)?.providerModel;
    const effort = registry.getEffort(model, request.task);

    const promptDir = await mkdtemp(join(tmpdir(), 'factory-pi-prompt-'));
    const promptPath = join(promptDir, 'prompt.txt');

    try {
      const cmd = buildPiCommand(providerModel, promptPath, effort === undefined ? undefined : String(effort));
      await writeFile(promptPath, prompt, 'utf8');
      const finalCmd = sandbox ? wrapCommandInSandbox(cmd, sandbox) : cmd;
      const childEnv: Record<string, string | undefined> = { ...env, DEEPSEEK_API_KEY: undefined };

      let stdout: string;
      let stderr: string;
      try {
        ({ stdout, stderr } = await this.execFn(finalCmd, {
          cwd: worktree,
          timeoutMs: timeoutSeconds * 1000,
          maxBuffer: 64 * 1024 * 1024,
          env: childEnv,
          onPgid,
        }));
      } catch (err: any) {
        const jsonErr = typeof err.stdout === 'string' ? (parsePiJson(err.stdout)?.errorText ?? '') : '';
        const classifyText = [err.stderr ?? '', jsonErr].filter(Boolean).join('\n');
        const reason = err.killed ? 'timeout' : classifyFailure(classifyText, err.code ?? 1);
        throw new HarnessError(err.message ?? String(err), reason, {
          exitCode: typeof err.code === 'number' ? err.code : undefined,
          stderr: err.stderr,
          code: typeof err.code === 'string' || typeof err.code === 'number' ? err.code : undefined,
          signal: typeof err.signal === 'string' ? err.signal : undefined,
          killed: err.killed === true ? true : undefined,
        });
      }

      const parsed = parsePiJson(stdout);
      if (!parsed) {
        throw new HarnessError('pi returned no JSON events', stdout.trim() ? 'error' : 'empty_response', {
          exitCode: 0,
          stderr,
        });
      }
      const detail = parsed.errorText ? `: ${parsed.errorText.split('\n')[0]}` : '';
      if (parsed.aborted === true) {
        throw new HarnessError(`pi run was aborted (agent_settled.aborted true)${detail}`, 'error', {
          exitCode: 0,
          stderr: stderr || undefined,
        });
      }
      if (parsed.lastStopReason === 'length') {
        throw new HarnessError(`pi response hit the output length limit (stopReason length)${detail}`, 'error', {
          exitCode: 0,
          stderr: stderr || undefined,
        });
      }
      if (parsed.lastStopReason !== 'stop' || parsed.aborted !== false) {
        const classified = classifyFailure([parsed.errorText, stderr].filter(Boolean).join('\n'), 0);
        const reason = PI_PROVIDER_REASONS.has(classified) ? classified : 'error';
        throw new HarnessError(
          `pi run did not finish cleanly (stopReason ${parsed.lastStopReason ?? 'missing'}, aborted ${String(parsed.aborted)})${detail}`,
          reason,
          { exitCode: 0, stderr: stderr || undefined, ...(parsed.errorText ? { diagnostic: parsed.errorText } : {}) },
        );
      }
      if (parsed.text.trim() === '') {
        throw new HarnessError('pi returned an empty final message', 'empty_response', { exitCode: 0 });
      }
      return { output: parsed.text, ...(parsed.usage ? { usage: parsed.usage } : {}) };
    } finally {
      await rm(promptDir, { recursive: true, force: true });
    }
  }
}
