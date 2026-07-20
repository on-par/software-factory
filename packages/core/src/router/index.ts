// src/router/index.ts — Model router with cost-tier routing and automatic failover

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { classifyFailure } from '../harness/classify.js';
import { ClaudeCliHarness } from '../harness/claude-cli.js';
import { CodexCliHarness } from '../harness/codex-cli.js';
import type { CodingHarness, HarnessFailureReason } from '../harness/index.js';
import { HarnessError, isAgenticHarness, isRetryableFailure, taskRequiresAgenticHarness } from '../harness/index.js';
import { OllamaAgenticHarness } from '../harness/ollama-agentic.js';
import { OllamaHttpHarness } from '../harness/ollama-http.js';
import { OpenCodeHarness } from '../harness/opencode.js';
import { ModelRegistry } from '../models/index.js';
import type { SandboxEventType, SandboxPolicy } from '../sandbox/index.js';
import { sandboxEventFromError } from '../sandbox/index.js';
import type { TaskType } from '../types/index.js';
import type { ExecFn } from '../utils/exec.js';
import { defaultExecFn } from '../utils/exec.js';
import { shellEscape } from '../utils/index.js';
import { extractFailoverReason, ModelExecutorError } from './executor-error.js';
import { describeFailureDetail } from './failure-detail.js';
import { captureWorktreeState, resetWorktreeState } from './worktree-state.js';

export type { ExecFn } from '../utils/exec.js';
export { extractFailoverReason, ModelExecutorError } from './executor-error.js';

export type SleepFn = (ms: number) => Promise<void>;

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

export type FailoverReason = HarnessFailureReason;

export interface RouterResult {
  model: string;
  output: string;
  exitCode: number;
  /** Why the winning model was reached via failover (undefined if the first model succeeded). */
  failoverReason?: FailoverReason;
  attempts: { model: string; reason: FailoverReason | null; ok: boolean; detail?: string }[];
}

/** Failed attempts that actually caused a model switch: the next attempt (or the
 *  final success) ran on a DIFFERENT model. Same-model retries (rate_limit
 *  cooldown, generic-error retry) are not failovers. */
export function failoversFrom(
  attempts: RouterResult['attempts'],
): { model: string; reason: FailoverReason; detail?: string }[] {
  const out: { model: string; reason: FailoverReason; detail?: string }[] = [];
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    if (a.ok || a.reason === null) continue;
    const next = attempts[i + 1];
    if (next && next.model !== a.model) {
      out.push({ model: a.model, reason: a.reason, ...(a.detail ? { detail: a.detail } : {}) });
    }
  }
  return out;
}

export interface ModelExecutorContext {
  worktree: string;
  timeoutSeconds: number;
  task: TaskType;
  registry: ModelRegistry;
  routesConfig: RoutesConfig;
  sandbox?: SandboxPolicy;
}

/** Executes a single resolved model. On failure, implementations should
 *  throw a ModelExecutorError (or let a HarnessError propagate) so the
 *  router can read a typed `reason`; plain Errors are classified from
 *  stderr/exit code as an intentional fallback. runModel must resolve
 *  only with non-empty (trimmed) output — empty provider output must
 *  surface as a typed error (HarnessError or ModelExecutorError) with
 *  reason 'empty_response', never as a resolved empty string. */
export interface ModelExecutor {
  runModel(model: string, prompt: string, ctx: ModelExecutorContext): Promise<string>;
}

/** A dispatch-map entry in CliModelExecutor: runs one model through one harness.
 *  This is the executor-internal seam (string in/out), not the CodingHarness
 *  contract — injected fakes only need to implement run(). Implementations
 *  must uphold the same non-empty-output guarantee as ModelExecutor: never
 *  resolve with empty output, surface it as a typed 'empty_response' error. */
export interface ExecutorHarness {
  run(model: string, prompt: string, ctx: ModelExecutorContext): Promise<string>;
}

export class CliModelExecutor implements ModelExecutor {
  private claudeHarness: ClaudeCliHarness;
  private codexHarness: CodexCliHarness;
  private ollamaHarness: OllamaHttpHarness;
  private opencodeHarness: OpenCodeHarness;
  private ollamaAgenticHarness: OllamaAgenticHarness;
  private harnesses: Record<string, ExecutorHarness>;

  constructor(
    private execFn: ExecFn = defaultExecFn,
    fetchFn: FetchFn = globalThis.fetch as unknown as FetchFn,
    harnessOverrides: Record<string, ExecutorHarness> = {},
  ) {
    this.claudeHarness = new ClaudeCliHarness(execFn);
    this.codexHarness = new CodexCliHarness(execFn);
    this.ollamaHarness = new OllamaHttpHarness(fetchFn);
    this.opencodeHarness = new OpenCodeHarness(execFn);
    this.ollamaAgenticHarness = new OllamaAgenticHarness(fetchFn, execFn);
    this.harnesses = {
      'claude-cli': { run: (m, p, c) => this.runViaHarness(this.claudeHarness, m, p, c) },
      'codex-cli': { run: (m, p, c) => this.runViaHarness(this.codexHarness, m, p, c) },
      'ollama-http': { run: (m, p, c) => this.runViaHarness(this.ollamaHarness, m, p, c) },
      'ollama-command-agent': {
        run: (m, p, c) => this.runOllamaCommandAgent(m, p, c.worktree, c.timeoutSeconds, c.registry),
      },
      opencode: { run: (m, p, c) => this.runViaHarness(this.opencodeHarness, m, p, c) },
      'ollama-agentic': { run: (m, p, c) => this.runViaHarness(this.ollamaAgenticHarness, m, p, c) },
      ...harnessOverrides,
    };
  }

  /** Harness ids this executor can dispatch — the defaults plus any injected
   *  overrides. Must stay in lockstep with HARNESS_CATALOG; a parity test in
   *  cli-executor.test.ts fails on any drift in either direction. */
  supportedHarnessIds(): string[] {
    return Object.keys(this.harnesses);
  }

  /** Run a single model via the harness declared (or inferred) for it in the registry. */
  async runModel(model: string, prompt: string, ctx: ModelExecutorContext): Promise<string> {
    const def = ctx.registry.get(model);
    if (!def) throw new Error(`Unknown model: ${model}`);

    const harnessId = ctx.registry.getHarnessId(model);
    if (!harnessId) {
      throw new Error(`Model '${model}' has no resolvable harness id — declare a 'harness' in models.json`);
    }
    const entry = this.harnesses[harnessId];
    if (!entry) {
      throw new Error(
        `Model '${model}' declares unknown harness '${harnessId}' (known harnesses: ${Object.keys(this.harnesses).join(', ')})`,
      );
    }
    if (!isAgenticHarness(harnessId) && taskRequiresAgenticHarness(ctx.task)) {
      throw new Error(
        `Model '${model}' uses non-agentic harness '${harnessId}', which cannot edit files — rejected for build task '${ctx.task}'`,
      );
    }
    return entry.run(model, prompt, ctx);
  }

  /** Delegate to a harness while preserving the CodingHarness contract:
   *  empty provider output rejects with HarnessError('empty_response'). */
  private async runViaHarness(
    harness: CodingHarness,
    model: string,
    prompt: string,
    ctx: Pick<ModelExecutorContext, 'worktree' | 'timeoutSeconds' | 'task' | 'registry' | 'sandbox'>,
  ): Promise<string> {
    const { output } = await harness.run({
      model,
      prompt,
      worktree: ctx.worktree,
      timeoutSeconds: ctx.timeoutSeconds,
      task: ctx.task,
      registry: ctx.registry,
      sandbox: ctx.sandbox,
    });
    return output;
  }

  /** Run a small local command loop for Ollama worker models. */
  private async runOllamaCommandAgent(
    model: string,
    prompt: string,
    worktree: string,
    timeoutSeconds: number,
    registry: ModelRegistry,
  ): Promise<string> {
    const transcript: string[] = [];
    const initialStatus = await this.execFn('git status --short', {
      cwd: worktree,
      timeoutMs: 30_000,
      maxBuffer: 1024 * 1024,
    })
      .then((result) => result.stdout)
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
        output = await this.callOllamaForCommandAgent(
          model,
          conversation,
          timeoutSeconds,
          registry,
          worktree,
          'build_codex',
        );
      } catch (err) {
        const reason = extractFailoverReason(err) ?? 'error';
        const message = err instanceof Error ? err.message : String(err);
        const trace = await this.writeLocalAgentCallFailureTrace({
          model,
          worktree,
          prompt,
          conversation,
          attempt: step + 1,
          failureReason: reason,
          errorMessage: message,
        });
        throw new ModelExecutorError(
          `local command-agent model call failed (${reason}); trace written to ${trace.tracePath}; error: ${message}`,
          reason,
          { tracePath: trace.tracePath },
        );
      }
      transcript.push(`MODEL STEP ${step + 1}:\n${output}`);
      const action = await this.parseLocalAgentActionWithRepair({
        model,
        prompt,
        conversation,
        output,
        worktree,
        timeoutSeconds,
        registry,
        step,
      });
      if (action.repairTranscript) transcript.push(action.repairTranscript);

      if (action.commands.length === 0) {
        if (action.done) break;
        const trace =
          action.traceForFailure ??
          (await this.writeLocalAgentTrace({
            model,
            worktree,
            prompt,
            conversation,
            attempt: step + 1,
            rawResponse: output,
            malformedReason: action.malformedReason ?? 'empty_response',
          }));
        throw new ModelExecutorError(
          `local command-agent malformed output (${trace.malformedReason}); trace written to ${trace.tracePath}; retry prompt ${trace.retryPromptPath}`,
          'empty_response',
          { tracePath: trace.tracePath },
        );
      }

      const commandOutputs: string[] = [];
      for (const command of action.commands.slice(0, 3)) {
        try {
          const { stdout, stderr } = await this.execFn(command, {
            cwd: worktree,
            timeoutMs: Math.max(30_000, Math.floor((timeoutSeconds * 1000) / 4)),
            maxBuffer: 10 * 1024 * 1024,
          });
          commandOutputs.push(`$ ${command}\nEXIT_CODE: 0\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
        } catch (err: any) {
          const exitCode = typeof err.code === 'number' ? err.code : err.killed ? 124 : 1;
          commandOutputs.push(
            `$ ${command}\nEXIT_CODE: ${exitCode}\nSTDOUT:\n${err.stdout ?? ''}\nSTDERR:\n${err.stderr ?? err.message ?? ''}`,
          );
        }
      }
      transcript.push(commandOutputs.join('\n\n'));
      conversation = `${prompt}

Previous command output:
${commandOutputs.join('\n\n').slice(-5000)}

Return next JSON command action. If committed, return {"commands":[],"done":true,"final":"done"}.`;
    }

    const status = await this.execFn('git status --short', {
      cwd: worktree,
      timeoutMs: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const changedPaths = parseGitStatusPaths(status.stdout).filter((path) => !initiallyDirty.has(path));
    if (changedPaths.length > 0) {
      await this.execFn(
        `git add -- ${changedPaths.map(shellEscape).join(' ')} && git commit -m "feat: implement factory issue"`,
        {
          cwd: worktree,
          timeoutMs: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
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
    timeoutSeconds: number;
    registry: ModelRegistry;
    step: number;
  }): Promise<
    ReturnType<typeof parseLocalAgentAction> & {
      repairTranscript?: string;
      traceForFailure?: LocalAgentTrace;
    }
  > {
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
      repairedOutput = await this.callOllamaForCommandAgent(
        opts.model,
        repairPrompt,
        opts.timeoutSeconds,
        opts.registry,
        opts.worktree,
        'build_codex',
      );
    } catch (err) {
      const reason = extractFailoverReason(err) ?? 'error';
      const message = err instanceof Error ? err.message : String(err);
      throw new ModelExecutorError(
        `local command-agent repair failed after malformed output (${trace.malformedReason}); trace written to ${trace.tracePath}; retry prompt ${trace.retryPromptPath}; repair error: ${message}`,
        reason,
        { tracePath: trace.tracePath },
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
    await writeFile(
      tracePath,
      `${JSON.stringify(
        {
          model: opts.model,
          attempt: opts.attempt,
          promptSize: opts.prompt.length,
          conversationSize: opts.conversation.length,
          malformedReason: opts.malformedReason,
          rawResponseSummary,
          retryPromptPath,
        },
        null,
        2,
      )}\n`,
    );
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
    await writeFile(
      tracePath,
      `${JSON.stringify(
        {
          model: opts.model,
          attempt: opts.attempt,
          promptSize: opts.prompt.length,
          conversationSize: opts.conversation.length,
          failureReason: opts.failureReason,
          errorMessage: opts.errorMessage,
        },
        null,
        2,
      )}\n`,
    );
    return { tracePath };
  }

  private async callOllama(
    model: string,
    prompt: string,
    timeoutSeconds: number,
    registry: ModelRegistry,
    worktree: string,
    task: TaskType,
  ): Promise<string> {
    return this.runViaHarness(this.ollamaHarness, model, prompt, { worktree, timeoutSeconds, task, registry });
  }

  /** Command-agent-only seam: the local command loop owns empty-output handling
   *  (it feeds '' into its malformed-output repair prompt), so an
   *  empty_response from a clean exit is returned as '' here instead of
   *  propagating. Every other path must let HarnessError('empty_response')
   *  propagate — ModelExecutor.runModel never resolves empty output. */
  private async callOllamaForCommandAgent(
    model: string,
    prompt: string,
    timeoutSeconds: number,
    registry: ModelRegistry,
    worktree: string,
    task: TaskType,
  ): Promise<string> {
    try {
      return await this.callOllama(model, prompt, timeoutSeconds, registry, worktree, task);
    } catch (err) {
      if (err instanceof HarnessError && err.reason === 'empty_response' && err.details.exitCode === 0) {
        return '';
      }
      throw err;
    }
  }
}

export class ModelRouter {
  private registry: ModelRegistry;

  constructor(
    modelsConfig: ModelsConfig,
    private routesConfig: RoutesConfig,
    private byok = false,
    private executor: ModelExecutor = new CliModelExecutor(),
    private allowExperimental = process.env.FACTORY_EXPERIMENTAL === '1',
    private localOnly = process.env.FACTORY_LOCAL_ONLY === '1',
    private gitExecFn: ExecFn = defaultExecFn,
    private sleepFn: SleepFn = sleep,
  ) {
    this.registry = new ModelRegistry(modelsConfig);
  }

  get registryRef() {
    return this.registry;
  }

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
    const requires = this.routesConfig.routes[task]?.requires;
    if (requires === 'codex') {
      models = models.filter((model) => this.registry.isCodexModel(model));
    } else if (requires === 'claude') {
      // build_claude's prompt contract assumes the claude-cli harness (it drives its
      // own commits). Running a codex-cli model here "succeeds" but leaves the
      // worktree with no commits, so the ship phase fails and parks the lane.
      models = models.filter((model) => this.registry.getHarnessId(model) === 'claude-cli');
    }
    if (taskRequiresAgenticHarness(task)) {
      models = models.filter((model) => isAgenticHarness(this.registry.getHarnessId(model) ?? ''));
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
      timeoutSeconds?: number;
      modelOverride?: string;
      onLog?: (msg: string) => void;
      sandbox?: SandboxPolicy;
      onSandboxEvent?: (type: SandboxEventType, detail: string) => void;
    } = {},
  ): Promise<RouterResult> {
    const { worktree = process.cwd(), timeoutSeconds = 1800, modelOverride, onLog = () => {}, sandbox } = options;

    const models = modelOverride ? [modelOverride] : this.resolveAll(task);
    if (models.length === 0) {
      throw new Error(`No available models for task '${task}'`);
    }

    const maxRetries = this.registry.failover.maxRetries;
    const cooldownMs = this.registry.failover.cooldownMs;
    const attempts: RouterResult['attempts'] = [];

    const snapshot = taskRequiresAgenticHarness(task)
      ? await captureWorktreeState(this.gitExecFn, worktree, onLog)
      : null;

    for (const model of models) {
      let retries = 0;

      while (retries <= maxRetries) {
        onLog(`Trying ${model} for ${task} (attempt ${retries + 1})`);

        let output: string;
        try {
          output = await this.executor.runModel(model, prompt, {
            worktree,
            timeoutSeconds,
            task,
            registry: this.registry,
            routesConfig: this.routesConfig,
            sandbox,
          });
        } catch (err) {
          if (sandbox) {
            const sandboxEvent = sandboxEventFromError(err);
            if (sandboxEvent) options.onSandboxEvent?.(sandboxEvent.type, sandboxEvent.detail);
          }
          const reason = extractFailoverReason(err) ?? this.classifyFailure(errStderr(err), errExitCode(err));
          const detail = describeFailureDetail(err);
          attempts.push(detail ? { model, reason, ok: false, detail } : { model, reason, ok: false });
          onLog(`${model} failed (${reason}) on ${task}`);
          if (detail) onLog(`${model} failure detail on ${task}: ${detail}`);

          // Deterministic failure — another model cannot plausibly help; do not
          // burn the next tier. Reason + attempts are preserved for event logs.
          if (!isRetryableFailure(reason)) {
            onLog(`${model} failed (${reason}) on ${task} — non-retryable, not failing over`);
            const error = new Error(
              `Non-retryable failure (${reason}) from ${model} for task '${task}'${detail ? `: ${detail}` : ''}`,
            ) as Error & { reason?: FailoverReason; attempts?: RouterResult['attempts'] };
            error.reason = reason;
            error.attempts = attempts;
            throw error;
          }

          if (snapshot) {
            try {
              const { didReset, tracePath } = await resetWorktreeState(this.gitExecFn, worktree, snapshot, onLog);
              if (didReset)
                onLog(
                  `Reset worktree to pre-attempt state after ${model} failure${tracePath ? ` (attempt diff preserved at ${tracePath})` : ''}`,
                );
            } catch (resetErr) {
              const message = resetErr instanceof Error ? resetErr.message : String(resetErr);
              const error = new Error(
                `Worktree reset failed after ${model} failure (${reason}) for task '${task}' — aborting failover to avoid mixing attempt state: ${message}`,
              ) as Error & { reason?: FailoverReason; attempts?: RouterResult['attempts'] };
              error.reason = 'error';
              error.attempts = attempts;
              throw error;
            }
          }

          // Rate limit → retry with cooldown
          if (reason === 'rate_limit' && retries < maxRetries) {
            retries++;
            onLog(`Rate limited — cooldown ${cooldownMs}ms before retry`);
            await this.sleepFn(cooldownMs);
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

          // This is the documented empty-output path: a harness throws
          // HarnessError('empty_response'), the executor propagates it
          // (CliModelExecutor no longer catches and resolves ''), it's
          // classified as retryable here, one attempt is recorded above,
          // and we fail over to the next model.
          break;
        }

        if (output.trim().length > 0) {
          // Success
          attempts.push({ model, reason: null, ok: true });
          const failovers = failoversFrom(attempts);
          const failoverReason = failovers.at(-1)?.reason;
          return {
            model,
            output: output,
            exitCode: 0,
            ...(failoverReason ? { failoverReason } : {}),
            attempts,
          };
        }

        // Defensive backstop for non-conforming executors: ModelExecutor.runModel
        // is documented to never resolve empty output, but if some injected/custom
        // executor does anyway, treat it the same as a thrown empty_response —
        // record exactly one attempt and fail over to the next model.
        attempts.push({ model, reason: 'empty_response', ok: false });
        onLog(`${model} failed (empty_response) on ${task}`);

        if (snapshot) {
          try {
            const { didReset, tracePath } = await resetWorktreeState(this.gitExecFn, worktree, snapshot, onLog);
            if (didReset)
              onLog(
                `Reset worktree to pre-attempt state after ${model} failure${tracePath ? ` (attempt diff preserved at ${tracePath})` : ''}`,
              );
          } catch (resetErr) {
            const message = resetErr instanceof Error ? resetErr.message : String(resetErr);
            const error = new Error(
              `Worktree reset failed after ${model} failure (empty_response) for task '${task}' — aborting failover to avoid mixing attempt state: ${message}`,
            ) as Error & { reason?: FailoverReason; attempts?: RouterResult['attempts'] };
            error.reason = 'error';
            error.attempts = attempts;
            throw error;
          }
        }
        break;
      }
    }

    const summary = attempts.map((a) => `${a.model}(${a.reason}${a.detail ? `: ${a.detail}` : ''})`).join(', ');
    const error = new Error(`All models failed for task '${task}': ${summary}`) as Error & {
      reason?: FailoverReason;
      attempts?: RouterResult['attempts'];
    };
    error.reason = attempts[attempts.length - 1]?.reason ?? 'error';
    error.attempts = attempts;
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errStderr(err: unknown): string {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  return typeof stderr === 'string' ? stderr : '';
}

function errExitCode(err: unknown): number {
  const exitCode = (err as { exitCode?: unknown } | null)?.exitCode;
  return typeof exitCode === 'number' ? exitCode : 1;
}

function parseLocalAgentAction(output: string): {
  commands: string[];
  done: boolean;
  final: string;
  malformedReason?: 'empty_response' | 'invalid_json';
} {
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
    .map((match) => match[1].trim())
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

  const commandValue =
    typeof value.command === 'string' ? value.command : typeof value.name === 'string' ? value.name : '';
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
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const path = line.slice(3).trim();
      return path.includes(' -> ') ? path.split(' -> ').pop()!.trim() : path;
    })
    .filter(Boolean);
}
