// src/router/index.ts — Model router with cost-tier routing and automatic failover

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { ModelRegistry } from '../models/index.js';
import type { TaskType } from '../types/index.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { HarnessError, isAgenticHarness, taskRequiresAgenticHarness } from '../harness/index.js';
import { ClaudeCliHarness } from '../harness/claude-cli.js';
import { CodexCliHarness } from '../harness/codex-cli.js';
import { OllamaHttpHarness } from '../harness/ollama-http.js';
import { OpenCodeHarness } from '../harness/opencode.js';
import { OllamaAgenticHarness } from '../harness/ollama-agentic.js';
import { classifyFailure } from '../harness/classify.js';

const exec = promisify(execCb);

export type ExecFn = (
  cmd: string,
  opts: { cwd?: string; timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

export type FetchFn = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

interface LocalAgentTrace {
  tracePath: string;
  retryPromptPath: string;
  malformedReason: 'empty_response' | 'invalid_json';
  rawResponseSummary: string;
}

export type FailoverReason =
  | 'rate_limit'
  | 'usage_cap'
  | 'timeout'
  | 'error'
  | 'empty_response'
  | 'unknown';

export interface RouterResult {
  model: string;
  output: string;
  exitCode: number;
  cost: number;
  attempts: { model: string; reason: FailoverReason | null; ok: boolean }[];
}

export interface ModelExecutorContext {
  worktree: string;
  timeout: number;
  task: TaskType;
  registry: ModelRegistry;
  routesConfig: RoutesConfig;
}

/** Executes a single resolved model. Implementations must, on failure,
 *  throw an Error carrying a `reason: FailoverReason` property (the router's
 *  catch block reads `err.reason ?? classifyFailure(...)`). */
export interface ModelExecutor {
  runModel(model: string, prompt: string, ctx: ModelExecutorContext): Promise<string>;
}

export class CliModelExecutor implements ModelExecutor {
  private claudeHarness: ClaudeCliHarness;
  private codexHarness: CodexCliHarness;
  private ollamaHarness: OllamaHttpHarness;
  private opencodeHarness: OpenCodeHarness;
  private ollamaAgenticHarness: OllamaAgenticHarness;
  private harnesses: Record<string, { run(model: string, prompt: string, ctx: ModelExecutorContext): Promise<string> }>;

  constructor(
    private execFn: ExecFn = exec,
    private fetchFn: FetchFn = globalThis.fetch as unknown as FetchFn,
  ) {
    this.claudeHarness = new ClaudeCliHarness(execFn);
    this.codexHarness = new CodexCliHarness(execFn);
    this.ollamaHarness = new OllamaHttpHarness(fetchFn);
    this.opencodeHarness = new OpenCodeHarness(execFn);
    this.ollamaAgenticHarness = new OllamaAgenticHarness(fetchFn, execFn);
    this.harnesses = {
      'claude-cli': { run: (m, p, c) => this.runClaude(m, p, c) },
      'codex-cli': { run: (m, p, c) => this.runCodex(m, p, c) },
      'ollama-http': { run: (m, p, c) => this.runOllama(m, p, c) },
      'ollama-command-agent': { run: (m, p, c) => this.runOllamaCommandAgent(m, p, c.worktree, c.timeout, c.registry) },
      'opencode': { run: (m, p, c) => this.runOpenCode(m, p, c) },
      'ollama-agentic': { run: (m, p, c) => this.runOllamaAgentic(m, p, c) },
    };
  }

  /** Run a single model via the harness declared (or inferred) for it in the registry. */
  async runModel(model: string, prompt: string, ctx: ModelExecutorContext): Promise<string> {
    const def = ctx.registry.get(model);
    if (!def) throw new Error(`Unknown model: ${model}`);

    const harnessId = ctx.registry.getHarnessId(model)!;
    const entry = this.harnesses[harnessId];
    if (!entry) {
      throw new Error(`Model '${model}' declares unknown harness '${harnessId}' (known harnesses: ${Object.keys(this.harnesses).join(', ')})`);
    }
    if (!isAgenticHarness(harnessId) && taskRequiresAgenticHarness(ctx.task)) {
      throw new Error(`Model '${model}' uses non-agentic harness '${harnessId}', which cannot edit files — rejected for build task '${ctx.task}'`);
    }
    return entry.run(model, prompt, ctx);
  }

  /** Run via Ollama's native HTTP API. */
  private async runOllama(model: string, prompt: string, ctx: ModelExecutorContext): Promise<string> {
    return this.callOllama(model, prompt, ctx.timeout, ctx.registry, ctx.worktree, ctx.task);
  }

  /** Run a small local command loop for Ollama worker models. */
  private async runOllamaCommandAgent(model: string, prompt: string, worktree: string, timeout: number, registry: ModelRegistry): Promise<string> {
    const transcript: string[] = [];
    const initialStatus = await this.execFn('git status --short', { cwd: worktree, timeout: 30_000, maxBuffer: 1024 * 1024 })
      .then(result => result.stdout)
      .catch(() => '');
    const initiallyDirty = new Set(parseGitStatusPaths(initialStatus));
    let conversation = `${prompt}

You are a local command worker. You act only by returning commands.
Return JSON only: {"commands":["..."],"done":false,"final":"short status"}
First inspect, then edit, then run one cheap check, then git add/commit.
    Use at most 3 commands per turn. No markdown.`;

    for (let step = 0; step < 8; step++) {
      let output: string;
      try {
        output = await this.callOllama(model, conversation, timeout, registry, worktree, 'build_codex');
      } catch (err: any) {
        const reason = err.reason ?? 'error' as FailoverReason;
        const trace = await this.writeLocalAgentCallFailureTrace({
          model,
          worktree,
          prompt,
          conversation,
          attempt: step + 1,
          failureReason: reason,
          errorMessage: err.message ?? String(err),
        });
        throw Object.assign(
          new Error(`local command-agent model call failed (${reason}); trace written to ${trace.tracePath}; error: ${err.message ?? String(err)}`),
          { reason, tracePath: trace.tracePath },
        );
      }
      transcript.push(`MODEL STEP ${step + 1}:\n${output}`);
      const action = await this.parseLocalAgentActionWithRepair({
        model,
        prompt,
        conversation,
        output,
        worktree,
        timeout,
        registry,
        step,
      });
      if (action.repairTranscript) transcript.push(action.repairTranscript);

      if (action.commands.length === 0) {
        if (action.done) break;
        const trace = action.traceForFailure ?? await this.writeLocalAgentTrace({
          model,
          worktree,
          prompt,
          conversation,
          attempt: step + 1,
          rawResponse: output,
          malformedReason: action.malformedReason ?? 'empty_response',
        });
        throw Object.assign(
          new Error(`local command-agent malformed output (${trace.malformedReason}); trace written to ${trace.tracePath}; retry prompt ${trace.retryPromptPath}`),
          { reason: 'empty_response' as FailoverReason, tracePath: trace.tracePath },
        );
      }

      const commandOutputs: string[] = [];
      for (const command of action.commands.slice(0, 3)) {
        try {
          const { stdout, stderr } = await this.execFn(command, {
            cwd: worktree,
            timeout: Math.max(30_000, Math.floor(timeout * 1000 / 4)),
            maxBuffer: 10 * 1024 * 1024,
          });
          commandOutputs.push(`$ ${command}\nEXIT_CODE: 0\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
        } catch (err: any) {
          const exitCode = typeof err.code === 'number' ? err.code : err.killed ? 124 : 1;
          commandOutputs.push(`$ ${command}\nEXIT_CODE: ${exitCode}\nSTDOUT:\n${err.stdout ?? ''}\nSTDERR:\n${err.stderr ?? err.message ?? ''}`);
        }
      }
      transcript.push(commandOutputs.join('\n\n'));
      conversation = `${prompt}

Previous command output:
${commandOutputs.join('\n\n').slice(-5000)}

Return next JSON command action. If committed, return {"commands":[],"done":true,"final":"done"}.`;
    }

    const status = await this.execFn('git status --short', { cwd: worktree, timeout: 30_000, maxBuffer: 1024 * 1024 });
    const changedPaths = parseGitStatusPaths(status.stdout).filter(path => !initiallyDirty.has(path));
    if (changedPaths.length > 0) {
      await this.execFn(`git add -- ${changedPaths.map(shellEscape).join(' ')} && git commit -m "feat: implement factory issue"`, {
        cwd: worktree,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      transcript.push(`AUTO-COMMIT: committed ${changedPaths.length} changed path(s).`);
    }

    return transcript.join('\n\n');
  }

  private async parseLocalAgentActionWithRepair(opts: {
    model: string;
    prompt: string;
    conversation: string;
    output: string;
    worktree: string;
    timeout: number;
    registry: ModelRegistry;
    step: number;
  }): Promise<ReturnType<typeof parseLocalAgentAction> & {
    repairTranscript?: string;
    traceForFailure?: LocalAgentTrace;
  }> {
    const action = parseLocalAgentAction(opts.output);
    if (action.commands.length > 0 || action.done) return action;

    const trace = await this.writeLocalAgentTrace({
      model: opts.model,
      worktree: opts.worktree,
      prompt: opts.prompt,
      conversation: opts.conversation,
      attempt: opts.step + 1,
      rawResponse: opts.output,
      malformedReason: action.malformedReason ?? 'empty_response',
    });
    const repairPrompt = buildLocalAgentRepairPrompt({
      retryPromptPath: trace.retryPromptPath,
      malformedReason: trace.malformedReason,
      rawSummary: trace.rawResponseSummary,
    });
    await writeFile(trace.retryPromptPath, repairPrompt);

    let repairedOutput: string;
    try {
      repairedOutput = await this.callOllama(opts.model, repairPrompt, opts.timeout, opts.registry, opts.worktree, 'build_codex');
    } catch (err: any) {
      throw Object.assign(
        new Error(`local command-agent repair failed after malformed output (${trace.malformedReason}); trace written to ${trace.tracePath}; retry prompt ${trace.retryPromptPath}; repair error: ${err.message ?? String(err)}`),
        { reason: err.reason ?? 'error' as FailoverReason, tracePath: trace.tracePath },
      );
    }
    const repairedAction = parseLocalAgentAction(repairedOutput);
    return {
      ...repairedAction,
      traceForFailure: repairedAction.commands.length === 0 && !repairedAction.done ? trace : undefined,
      repairTranscript: [
        `REPAIR STEP ${opts.step + 1}:`,
        `TRACE: ${trace.tracePath}`,
        `RETRY PROMPT: ${trace.retryPromptPath}`,
        repairedOutput,
      ].join('\n'),
    };
  }

  private async writeLocalAgentTrace(opts: {
    model: string;
    worktree: string;
    prompt: string;
    conversation: string;
    attempt: number;
    rawResponse: string;
    malformedReason: 'empty_response' | 'invalid_json';
  }): Promise<LocalAgentTrace> {
    const traceDir = join(opts.worktree, '.factory', 'local-agent-traces');
    await mkdir(traceDir, { recursive: true });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const retryPromptPath = join(traceDir, `${stamp}-repair-prompt.md`);
    const tracePath = join(traceDir, `${stamp}.json`);
    const rawResponseSummary = summarizeRawResponse(opts.rawResponse);
    await writeFile(tracePath, `${JSON.stringify({
      model: opts.model,
      attempt: opts.attempt,
      promptSize: opts.prompt.length,
      conversationSize: opts.conversation.length,
      malformedReason: opts.malformedReason,
      rawResponseSummary,
      retryPromptPath,
    }, null, 2)}\n`);
    return { tracePath, retryPromptPath, malformedReason: opts.malformedReason, rawResponseSummary };
  }

  private async writeLocalAgentCallFailureTrace(opts: {
    model: string;
    worktree: string;
    prompt: string;
    conversation: string;
    attempt: number;
    failureReason: FailoverReason;
    errorMessage: string;
  }): Promise<{ tracePath: string }> {
    const traceDir = join(opts.worktree, '.factory', 'local-agent-traces');
    await mkdir(traceDir, { recursive: true });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tracePath = join(traceDir, `${stamp}-call-failure.json`);
    await writeFile(tracePath, `${JSON.stringify({
      model: opts.model,
      attempt: opts.attempt,
      promptSize: opts.prompt.length,
      conversationSize: opts.conversation.length,
      failureReason: opts.failureReason,
      errorMessage: opts.errorMessage,
    }, null, 2)}\n`);
    return { tracePath };
  }

  private async callOllama(model: string, prompt: string, timeout: number, registry: ModelRegistry, worktree: string, task: TaskType): Promise<string> {
    try {
      const { output } = await this.ollamaHarness.run({
        model, prompt, worktree, timeoutSeconds: timeout, task, registry,
      });
      return output;
    } catch (err: any) {
      if (err instanceof HarnessError && err.reason === 'empty_response' && err.details.exitCode === 0) {
        // The harness contract forbids resolving with empty output, but the
        // router's run loop and the command-agent loop own empty-output
        // handling — return it unchanged so router behavior is byte-identical.
        return '';
      }
      throw err;
    }
  }

  /** Run via Claude CLI (delegates to ClaudeCliHarness). */
  private async runClaude(model: string, prompt: string, ctx: ModelExecutorContext): Promise<string> {
    try {
      const { output } = await this.claudeHarness.run({
        model,
        prompt,
        worktree: ctx.worktree,
        timeoutSeconds: ctx.timeout,
        task: ctx.task,
        registry: ctx.registry,
      });
      return output;
    } catch (err: any) {
      if (err instanceof HarnessError && err.reason === 'empty_response' && err.details.exitCode === 0) {
        // The harness contract forbids resolving with empty output, but the
        // router's run loop owns empty-output handling for executors —
        // return it unchanged so router behavior is byte-identical.
        return '';
      }
      throw err;
    }
  }

  /** Run via Codex CLI (delegates to CodexCliHarness). */
  private async runCodex(model: string, prompt: string, ctx: ModelExecutorContext): Promise<string> {
    try {
      const { output } = await this.codexHarness.run({
        model,
        prompt,
        worktree: ctx.worktree,
        timeoutSeconds: ctx.timeout,
        task: ctx.task,
        registry: ctx.registry,
      });
      return output;
    } catch (err: any) {
      if (err instanceof HarnessError && err.reason === 'empty_response' && err.details.exitCode === 0) {
        // The harness contract forbids resolving with empty output, but the
        // router's run loop owns empty-output handling for executors —
        // return it unchanged so router behavior is byte-identical.
        return '';
      }
      throw err;
    }
  }

  /** Run via OpenCode CLI (delegates to OpenCodeHarness). */
  private async runOpenCode(model: string, prompt: string, ctx: ModelExecutorContext): Promise<string> {
    try {
      const { output } = await this.opencodeHarness.run({
        model,
        prompt,
        worktree: ctx.worktree,
        timeoutSeconds: ctx.timeout,
        task: ctx.task,
        registry: ctx.registry,
      });
      return output;
    } catch (err: any) {
      if (err instanceof HarnessError && err.reason === 'empty_response' && err.details.exitCode === 0) {
        // The harness contract forbids resolving with empty output, but the
        // router's run loop owns empty-output handling for executors —
        // return it unchanged so router behavior is byte-identical.
        return '';
      }
      throw err;
    }
  }

  /** Run via the schema-bound Ollama patch harness (delegates to OllamaAgenticHarness). */
  private async runOllamaAgentic(model: string, prompt: string, ctx: ModelExecutorContext): Promise<string> {
    try {
      const { output } = await this.ollamaAgenticHarness.run({
        model,
        prompt,
        worktree: ctx.worktree,
        timeoutSeconds: ctx.timeout,
        task: ctx.task,
        registry: ctx.registry,
      });
      return output;
    } catch (err: any) {
      if (err instanceof HarnessError && err.reason === 'empty_response' && err.details.exitCode === 0) {
        // The harness contract forbids resolving with empty output, but the
        // router's run loop owns empty-output handling for executors —
        // return it unchanged so router behavior is byte-identical.
        return '';
      }
      throw err;
    }
  }
}

export class ModelRouter {
  private registry: ModelRegistry;

  constructor(
    private modelsConfig: ModelsConfig,
    private routesConfig: RoutesConfig,
    private byok = false,
    private executor: ModelExecutor = new CliModelExecutor(),
    private allowExperimental = process.env.FACTORY_EXPERIMENTAL === '1',
    private localOnly = process.env.FACTORY_LOCAL_ONLY === '1',
  ) {
    this.registry = new ModelRegistry(modelsConfig);
  }

  get registryRef() { return this.registry; }

  /** Resolve a task type to its tier */
  getTier(task: TaskType): string | undefined {
    return this.routesConfig.routes[task]?.tier;
  }

  /** Resolve a task type to the first available model */
  resolve(task: TaskType): string | undefined {
    return this.resolveAll(task)[0];
  }

  /** Resolve all available models for a task (for failover chain) */
  resolveAll(task: TaskType): string[] {
    const tier = this.getTier(task);
    if (!tier) return [];
    let models = this.registry.getAvailableModelsForTier(tier, this.byok, this.allowExperimental, this.localOnly);
    if (this.routesConfig.routes[task]?.requires === 'codex') {
      models = models.filter(model => this.registry.isCodexModel(model));
    }
    if (taskRequiresAgenticHarness(task)) {
      models = models.filter(model => isAgenticHarness(this.registry.getHarnessId(model) ?? ''));
    }
    return models;
  }

  /** Classify a failure from stderr/exit code */
  classifyFailure(stderr: string, exitCode: number): FailoverReason {
    return classifyFailure(stderr, exitCode);
  }

  /**
   * Run a model with failover.
   * Tries the resolved model; on failure, classifies and fails over to the next.
   * Returns the model that succeeded and the output.
   */
  async run(
    task: TaskType,
    prompt: string,
    options: {
      worktree?: string;
      timeout?: number;
      modelOverride?: string;
      onLog?: (msg: string) => void;
    } = {},
  ): Promise<RouterResult> {
    const { worktree = process.cwd(), timeout = 1800, modelOverride, onLog = () => {} } = options;

    const models = modelOverride ? [modelOverride] : this.resolveAll(task);
    if (models.length === 0) {
      throw new Error(`No available models for task '${task}'`);
    }

    const maxRetries = this.registry.failover.maxRetries;
    const cooldownMs = this.registry.failover.cooldownMs;
    const attempts: RouterResult['attempts'] = [];

    for (const model of models) {
      let retries = 0;

      while (retries <= maxRetries) {
        onLog(`Trying ${model} for ${task} (attempt ${retries + 1})`);

        try {
          const output = await this.executor.runModel(model, prompt, {
            worktree, timeout, task, registry: this.registry, routesConfig: this.routesConfig,
          });

          if (output.trim().length > 0) {
            // Success
            attempts.push({ model, reason: null, ok: true });
            return {
              model,
              output: output,
              exitCode: 0,
              cost: 0, // cost tracked separately
              attempts,
            };
          } else {
            attempts.push({ model, reason: 'empty_response', ok: false });
            throw new Error('empty response');
          }
        } catch (err: any) {
          const reason = err.reason ?? this.classifyFailure(err.stderr ?? '', err.exitCode ?? 1);
          attempts.push({ model, reason, ok: false });
          onLog(`${model} failed (${reason}) on ${task}`);
          if (err.tracePath) onLog(`local command-agent trace: ${err.message}`);

          // Rate limit → retry with cooldown
          if (reason === 'rate_limit' && retries < maxRetries) {
            retries++;
            onLog(`Rate limited — cooldown ${cooldownMs}ms before retry`);
            await sleep(cooldownMs);
            continue;
          }

          // Usage cap → failover immediately
          if (reason === 'usage_cap') {
            onLog(`Usage cap hit on ${model} — failing over to next model`);
            break;
          }

          // Timeout → failover
          if (reason === 'timeout') {
            onLog(`${model} timed out on ${task} — failing over`);
            break;
          }

          // Generic error → retry once, then failover
          if (reason === 'error' && retries < 1) {
            retries++;
            continue;
          }

          // Empty response → failover
          break;
        }
      }
    }

    const error = new Error(`All models failed for task '${task}': ${attempts.map(a => `${a.model}(${a.reason})`).join(', ')}`) as Error & {
      reason?: FailoverReason;
      attempts?: RouterResult['attempts'];
    };
    error.reason = attempts[attempts.length - 1]?.reason ?? 'error';
    error.attempts = attempts;
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseLocalAgentAction(output: string): { commands: string[]; done: boolean; final: string; malformedReason?: 'empty_response' | 'invalid_json' } {
  if (output.trim().length === 0) {
    return { commands: [], done: false, final: '', malformedReason: 'empty_response' };
  }

  const jsonText = extractJsonObject(output);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as { commands?: unknown; done?: unknown; final?: unknown };
      return {
        commands: Array.isArray(parsed.commands) ? parsed.commands.flatMap(normalizeLocalCommand) : [],
        done: parsed.done === true,
        final: typeof parsed.final === 'string' ? parsed.final : '',
      };
    } catch {
      return { commands: [], done: false, final: output.trim(), malformedReason: 'invalid_json' };
    }
  }

  const fenced = [...output.matchAll(/```(?:bash|sh|zsh|shell)?\n([\s\S]*?)```/g)]
    .map(match => match[1].trim())
    .filter(Boolean);
  if (fenced.length > 0) return { commands: fenced, done: false, final: '' };

  return { commands: [], done: false, final: output.trim(), malformedReason: 'invalid_json' };
}

function normalizeLocalCommand(value: unknown): string[] {
  if (typeof value === 'string') {
    const command = value.trim();
    return command ? [command] : [];
  }
  if (!isPlainObject(value)) return [];

  const commandValue = typeof value.command === 'string'
    ? value.command
    : typeof value.name === 'string'
      ? value.name
      : '';
  const command = commandValue.trim();
  if (!command) return [];
  if (!Array.isArray(value.args) || value.args.length === 0) return [command];
  const args = value.args.filter((arg): arg is string => typeof arg === 'string');
  if (args.length !== value.args.length) return [];
  return [`${command} ${args.map(shellEscape).join(' ')}`];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildLocalAgentRepairPrompt(opts: {
  retryPromptPath: string;
  malformedReason: 'empty_response' | 'invalid_json';
  rawSummary: string;
}): string {
  return `Your previous local command-agent response was malformed: ${opts.malformedReason}.
Trace retry prompt path: ${opts.retryPromptPath}
Raw response summary: ${opts.rawSummary}

Return exactly one JSON object, no markdown, no prose:
{"commands":["one safe shell command"],"done":false,"final":"short status"}

If the task is already complete, return:
{"commands":[],"done":true,"final":"done"}`;
}

function summarizeRawResponse(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '<empty>';
  return trimmed.replace(/\s+/g, ' ').slice(0, 500);
}

function extractJsonObject(output: string): string | undefined {
  const fenced = output.match(/```(?:json)?\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();

  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start >= 0 && end > start) return output.slice(start, end + 1);
  return undefined;
}

function parseGitStatusPaths(status: string): string[] {
  return status
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => {
      const path = line.slice(3).trim();
      return path.includes(' -> ') ? path.split(' -> ').pop()!.trim() : path;
    })
    .filter(Boolean);
}

/** Minimal shell escaping for safe CLI args */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
