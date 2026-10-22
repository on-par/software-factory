// src/router/index.ts — Model router with cost-tier routing and automatic failover

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { isOpenCodeZenModel } from '../config/provider-order.js';
import { harnessCliCommand, retiredHarnessNotice } from '../harness/catalog.js';
import { classifyFailure } from '../harness/classify.js';
import { ClaudeCliHarness } from '../harness/claude-cli.js';
import { CodexCliHarness } from '../harness/codex-cli.js';
import { DEFAULT_CODEX_CONTEXT_CEILING } from '../harness/codex-context-ceiling.js';
import { CommandHarness } from '../harness/command.js';
import type { CodingHarness, HarnessFailureReason, HarnessLiveUsage, HarnessUsage } from '../harness/index.js';
import { taskRequiresAgenticHarness } from '../harness/index.js';
import type { ProviderFailure, ProviderFailureKind } from '../harness/provider-failure.js';
import { providerFailureOf } from '../harness/provider-failure.js';
import { OllamaAgenticHarness } from '../harness/ollama-agentic.js';
import { OllamaHttpHarness } from '../harness/ollama-http.js';
import { OpenCodeHarness } from '../harness/opencode.js';
import { PiHarness } from '../harness/pi.js';
import { isHarnessCliPresent, ModelRegistry } from '../models/index.js';
import type { SandboxEventType, SandboxPolicy } from '../sandbox/index.js';
import { sandboxEventFromError } from '../sandbox/index.js';
import type { CostEntry, RetryCause, TaskType } from '../types/index.js';
import type { ExecFn } from '../utils/exec.js';
import { defaultExecFn } from '../utils/exec.js';
import { type LocalAuthAgent, localAuthAgentFor } from '../utils/local-auth-record.js';
import { BudgetStopError, type BudgetGuard, watchBudget } from './budget-guard.js';
import { type ContextCeilingNotice, contextCeilingFor, contextCeilingNotice } from './context-ceiling.js';
import { costRow } from './cost-row.js';
import { ModelRouterError, type RouterAttempt } from './executor-error.js';
import { describeFailureDetail } from './failure-detail.js';
import { claimOllamaSkipNotice, type OllamaProbeResult, probeOllama } from './ollama-probe.js';
import { throwIfWorktreeMissing, worktreeExists } from './missing-worktree.js';
import { filterModelsByRequires } from './requires.js';
import { captureWorktreeState, resetWorktreeState } from './worktree-state.js';

export type { ExecFn } from '../utils/exec.js';
export type { OllamaProbeResult } from './ollama-probe.js';
export { ModelExecutorError, ModelRouterError } from './executor-error.js';

const PROVIDER_LEVEL_FAILURES = new Set<FailoverReason>(['usage_cap', 'rate_limit', 'timeout', 'unavailable']);

/** Whether a failure opens the provider breaker. Deliberately the explicit reason set plus kind `auth`, not every
 *  kind: `unavailable` also covers error/unknown/empty_response/cli_missing/local_auth, which fail over without
 *  blocking the provider (#3225). */
function opensProviderBreaker(failure: ProviderFailure): boolean {
  return PROVIDER_LEVEL_FAILURES.has(failure.reason) || failure.kind === 'auth';
}

export type ProviderFailureInfo = {
  provider: string;
  reason: FailoverReason;
  /** Always set by the router; optional so callers that synthesize a failure (tests, bookkeeping) may omit it. */
  kind?: ProviderFailureKind;
  resetAt?: string;
  detail?: string;
  model?: string;
  harness?: string;
};

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

export type FailoverReason = HarnessFailureReason;

export interface RouterResult {
  model: string;
  output: string;
  exitCode: number;
  /** Why the winning model was reached via failover (undefined if the first model succeeded). */
  failoverReason?: FailoverReason;
  attempts: RouterAttempt[];
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
  writableRoots?: readonly string[];
  primaryRepoRoot?: string;
  codexFullAccessTasks?: readonly string[];
  /** Codex auto-compact limit for agentic build tasks, from build.contextCeiling (#3327). */
  contextCeiling?: number;
  /** Extra child-env vars (e.g. the lane's PORT lease) merged over the parent env. */
  env?: Record<string, string>;
  /** When set, the harness's exec child is spawned detached (its own
   *  process group) and its pid reported here so the lane can track and
   *  later kill the whole group. */
  onPgid?: (pgid: number) => void;
  /** Reports provider-reported token usage for the attempt, when the harness
   *  surfaces one (#424). Called at most once per runModel call. */
  onUsage?: (usage: HarnessUsage) => void;
  /** Cumulative usage while the session runs (#3320); forwarded to HarnessRequest.onUsage. */
  onLiveUsage?: (cumulative: HarnessLiveUsage) => void;
}

/** Execute one model; failure and empty output must surface as typed errors. */
export interface ModelExecutor {
  runModel(model: string, prompt: string, ctx: ModelExecutorContext): Promise<string>;
  /** Optional: report whether the Ollama endpoint answers. Executors that omit it never have Ollama models skipped. */
  probeOllama?(): Promise<OllamaProbeResult>;
}

/** Builds the CodingHarness that runs one model; looked up by harness id. */
type HarnessFactory = (harnessId: string, ctx: ModelExecutorContext, model: string) => CodingHarness;

export class CliModelExecutor implements ModelExecutor {
  private claudeHarness: ClaudeCliHarness;
  private codexHarness: CodexCliHarness;
  private ollamaHarness: OllamaHttpHarness;
  private opencodeHarness: OpenCodeHarness;
  private piHarness: PiHarness;
  private ollamaAgenticHarness: OllamaAgenticHarness;
  private harnesses: Record<string, HarnessFactory>;

  constructor(
    private execFn: ExecFn = defaultExecFn,
    private fetchFn: FetchFn = globalThis.fetch,
    harnessOverrides: Record<string, CodingHarness> = {},
  ) {
    this.claudeHarness = new ClaudeCliHarness(execFn);
    this.codexHarness = new CodexCliHarness(execFn);
    this.ollamaHarness = new OllamaHttpHarness(fetchFn);
    this.opencodeHarness = new OpenCodeHarness(execFn);
    this.piHarness = new PiHarness(execFn);
    this.ollamaAgenticHarness = new OllamaAgenticHarness(fetchFn, execFn);
    this.harnesses = {
      'claude-cli': () => this.claudeHarness,
      'codex-cli': () => this.codexHarness,
      'ollama-http': () => this.ollamaHarness,
      opencode: () => this.opencodeHarness,
      pi: () => this.piHarness,
      'ollama-agentic': () => this.ollamaAgenticHarness,
      command: (harnessId, ctx, model) => {
        const declaration = ctx.registry.getHarnessDeclaration(harnessId);
        if (!declaration) {
          throw new Error(
            `Model '${model}' uses the command harness, which needs a matching entry under 'harnesses' (none declared for '${harnessId}')`,
          );
        }
        return new CommandHarness(harnessId, declaration, this.execFn);
      },
      ...Object.fromEntries(Object.entries(harnessOverrides).map(([id, h]) => [id, () => h])),
    };
  }

  /** Harness ids this executor can dispatch — the defaults plus any injected
   *  overrides. Must stay in lockstep with HARNESS_CATALOG; a parity test in
   *  cli-executor.test.ts fails on any drift in either direction. */
  supportedHarnessIds(): string[] {
    return Object.keys(this.harnesses);
  }

  probeOllama(): Promise<OllamaProbeResult> {
    return probeOllama(this.fetchFn);
  }

  /** Run a single model via the harness declared (or inferred) for it in the registry. */
  async runModel(model: string, prompt: string, ctx: ModelExecutorContext): Promise<string> {
    const def = ctx.registry.get(model);
    if (!def) throw new Error(`Unknown model: ${model}`);

    const harnessId = ctx.registry.getHarnessId(model);
    if (!harnessId) {
      throw new Error(`Model '${model}' has no resolvable harness id — declare a 'harness' in models.json`);
    }
    const factory =
      this.harnesses[harnessId] ?? (ctx.registry.getHarnessDeclaration(harnessId) ? this.harnesses.command : undefined);
    if (!factory) {
      throw new Error(
        `Model '${model}' declares unknown harness '${harnessId}' (known harnesses: ${Object.keys(this.harnesses).join(', ')})`,
      );
    }
    if (!ctx.registry.isAgenticHarnessId(harnessId) && taskRequiresAgenticHarness(ctx.task)) {
      throw new Error(
        `Model '${model}' uses non-agentic harness '${harnessId}', which cannot edit files — rejected for build task '${ctx.task}'`,
      );
    }
    return this.runViaHarness(factory(harnessId, ctx, model), model, prompt, ctx);
  }

  /** Delegate to a harness while preserving the CodingHarness contract:
   *  empty provider output rejects with HarnessError('empty_response'). */
  private async runViaHarness(
    harness: CodingHarness,
    model: string,
    prompt: string,
    ctx: Pick<
      ModelExecutorContext,
      | 'worktree'
      | 'timeoutSeconds'
      | 'task'
      | 'registry'
      | 'sandbox'
      | 'writableRoots'
      | 'primaryRepoRoot'
      | 'codexFullAccessTasks'
      | 'contextCeiling'
      | 'env'
      | 'onPgid'
      | 'onUsage'
      | 'onLiveUsage'
    >,
  ): Promise<string> {
    const { output, usage } = await harness.run({
      model,
      prompt,
      worktree: ctx.worktree,
      timeoutSeconds: ctx.timeoutSeconds,
      task: ctx.task,
      registry: ctx.registry,
      sandbox: ctx.sandbox,
      writableRoots: ctx.writableRoots,
      primaryRepoRoot: ctx.primaryRepoRoot,
      codexFullAccessTasks: ctx.codexFullAccessTasks,
      contextCeiling: ctx.contextCeiling,
      env: ctx.env,
      onPgid: ctx.onPgid,
      onUsage: ctx.onLiveUsage,
    });
    if (usage) ctx.onUsage?.(usage);
    return output;
  }
}

/** Cost sink for router runs. `issue`/`ts` are filled by the caller/logCost. */
export type CostSink = (entry: Omit<CostEntry, 'ts' | 'issue'>) => void;

export class ModelRouter {
  private registry: ModelRegistry;
  private costSink?: CostSink;
  private harnessCliAvailable?: (harnessId: string) => boolean;
  /** Agent CLIs (harness ids) that failed local_auth during this router's run (#2495). One
   *  router serves one run, so a signed-out CLI is tried once and then skipped by every later
   *  task, and PLAN stops offering its build route. */
  private readonly meteredPrimaryNoticed = new Set<string>();
  private readonly authTripped = new Set<string>();
  /** Harness ids already reported as missing their CLI. One router serves one run, so each
   *  harness is logged at most once per run (#2629). */
  private readonly missingHarnessNoticed = new Set<string>();
  /** Models already warned about resolving through a retired harness id; once per run (#3445). */
  private readonly retiredHarnessNoticed = new Set<string>();
  private localAuthSink?: (agent: LocalAuthAgent) => void;
  private providerGate?: (provider: string) => Promise<boolean>;
  private codexFullAccessTasks: readonly string[] = [];
  private contextCeilings: Readonly<Record<string, number>> = { 'codex-cli': DEFAULT_CODEX_CONTEXT_CEILING };
  private codexWorkspacePaths?: { primaryRepoRoot: string; writableRoots: readonly string[] };

  constructor(
    modelsConfig: ModelsConfig,
    private routesConfig: RoutesConfig,
    private byok = false,
    private executor: ModelExecutor = new CliModelExecutor(),
    private allowExperimental = false,
    private localOnly = false,
    private gitExecFn: ExecFn = defaultExecFn,
    private sleepFn: SleepFn = sleep,
  ) {
    this.registry = new ModelRegistry(modelsConfig);
  }

  get registryRef() {
    return this.registry;
  }

  /** Resolved config allowlist, available even when the OS sandbox is disabled. */
  setCodexFullAccessTasks(tasks: readonly string[] | undefined): void {
    this.codexFullAccessTasks = [...(tasks ?? [])];
  }

  /** Per-harness context ceilings from build.contextCeiling; undefined restores the packaged default (#3327). */
  setContextCeilings(ceilings: Readonly<Record<string, number>> | undefined): void {
    this.contextCeilings = ceilings ? { ...ceilings } : { 'codex-cli': DEFAULT_CODEX_CONTEXT_CEILING };
  }

  /** Factory paths resolved for this run, separate from the OS sandbox's broader paths. */
  setCodexWorkspacePaths(paths: { primaryRepoRoot: string; writableRoots: readonly string[] }): void {
    this.codexWorkspacePaths = paths;
  }

  /** Skip models whose harness CLI is not on PATH (for example claude-cli models on a machine
   *  with only the codex CLI), so routing never spends retries on an agent that cannot start.
   *  Harnesses without a CLI probe (Ollama, declared harnesses) are never skipped. Results are
   *  cached per command for the router's lifetime. */
  skipMissingHarnessClis(commandAvailable: (cmd: string) => boolean): void {
    const cache = new Map<string, boolean>();
    const cachedCommandAvailable = (cmd: string): boolean => {
      let ok = cache.get(cmd);
      if (ok === undefined) {
        ok = commandAvailable(cmd);
        cache.set(cmd, ok);
      }
      return ok;
    };
    this.harnessCliAvailable = (harnessId) => isHarnessCliPresent(harnessId, cachedCommandAvailable);
  }

  private harnessCliMissing(model: string): boolean {
    return this.harnessCliAvailable !== undefined && !this.harnessCliAvailable(this.registry.getHarnessId(model) ?? '');
  }
  private noticeMissingHarness(model: string, onLog: (msg: string) => void): void {
    const harnessId = this.registry.getHarnessId(model) ?? '';
    if (this.missingHarnessNoticed.has(harnessId)) return;
    this.missingHarnessNoticed.add(harnessId);
    onLog(
      `Skipping ${harnessId} models for the rest of this run: ${harnessCliCommand(harnessId)} CLI not found on PATH`,
    );
  }
  private noticeRetiredHarness(model: string, onLog: (msg: string) => void): void {
    const retired = this.registry.retiredHarnessId(model);
    if (!retired || this.retiredHarnessNoticed.has(model)) return;
    this.retiredHarnessNoticed.add(model);
    onLog(retiredHarnessNotice(model, retired));
  }
  private authKey(model: string): string | undefined {
    return this.registry.getHarnessId(model) ?? this.registry.get(model)?.provider;
  }
  private isAuthTripped(model: string): boolean {
    const key = this.authKey(model);
    return key !== undefined && this.authTripped.has(key);
  }
  /** Register a sink told which agent login (claude / codex / opencode) failed local_auth, so doctor can
   *  flag it until the next login (#2733). Receives only the agent name. */
  setLocalAuthSink(sink: (agent: LocalAuthAgent) => void): void {
    this.localAuthSink = sink;
  }
  /** Register a gate consulted before each model: when it resolves true for the model's provider, that provider is
   *  skipped without a call (an auth breaker is open, #3232). A throwing gate never blocks a model. */
  setProviderGate(gate: ((provider: string) => Promise<boolean>) | undefined): void {
    this.providerGate = gate;
  }
  /** Register a sink that receives one cost row per successful run(). */
  setCostSink(sink: CostSink): void {
    this.costSink = sink;
  }
  private recordCost(
    task: TaskType,
    model: string,
    prompt: string,
    output: string,
    failoverReason?: FailoverReason,
    retryCause?: RetryCause,
    usage?: HarnessUsage,
    elapsedMs?: number,
  ): void {
    if (!this.costSink) return;
    this.costSink(
      costRow(this.registry, { task, model, prompt, output, failoverReason, retryCause, usage, elapsedMs }),
    );
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
    if (this.harnessCliAvailable) models = models.filter((model) => !this.harnessCliMissing(model));
    if (this.authTripped.size > 0) models = models.filter((model) => !this.isAuthTripped(model));
    const requires = this.routesConfig.routes[task]?.requires;
    models = filterModelsByRequires(this.registry, models, requires);
    if (taskRequiresAgenticHarness(task)) {
      models = models.filter((model) => this.registry.isAgenticHarnessId(this.registry.getHarnessId(model) ?? ''));
    }
    return models;
  }

  /** Classify a failure from stderr/exit code */
  classifyFailure(stderr: string, exitCode: number): FailoverReason {
    return classifyFailure(stderr, exitCode);
  }

  /** Try resolved models in order, returning the first successful output. */
  async run(
    task: TaskType,
    prompt: string,
    options: {
      worktree?: string;
      timeoutSeconds?: number;
      modelOverride?: string;
      /** Explicit ordered alternates, normally from a repo's provider policy. */
      modelFallbacks?: string[];
      /** Called when a provider-level failure should temporarily remove that provider from rotation.
       *  `detail` is the sanitized failure detail (see describeFailureDetail), forwarded so callers
       *  can extract provider-reported cooldown hints (e.g. "Resets in 3hr 17min"). */
      onProviderFailure?: (info: ProviderFailureInfo) => void | Promise<void>;
      onLog?: (msg: string) => void;
      sandbox?: SandboxPolicy;
      onSandboxEvent?: (type: SandboxEventType, detail: string) => void;
      env?: Record<string, string>;
      onPgid?: (pgid: number) => void;
      retryCause?: RetryCause;
      /** Per-issue budget guard for BUILD/rework (#3320). */
      budgetGuard?: BudgetGuard;
      /** Called once per agentic-task run with the context ceiling of the first attempted model (#3327). */
      onContextCeiling?: (notice: ContextCeilingNotice) => void;
    } = {},
  ): Promise<RouterResult> {
    const {
      worktree = process.cwd(),
      timeoutSeconds = 1800,
      modelOverride,
      modelFallbacks = [],
      onProviderFailure,
      onLog = () => {},
      sandbox,
      env,
      onPgid,
      retryCause,
    } = options;

    if (!modelOverride && this.harnessCliAvailable) {
      const tier = this.getTier(task);
      if (tier) {
        for (const m of this.registry.getAvailableModelsForTier(
          tier,
          this.byok,
          this.allowExperimental,
          this.localOnly,
        )) {
          if (this.harnessCliMissing(m)) this.noticeMissingHarness(m, onLog);
        }
      }
    }

    const models = modelOverride
      ? [modelOverride, ...modelFallbacks.filter((id) => id !== modelOverride)]
      : this.resolveAll(task);
    if (models.length === 0) {
      if (this.authTripped.size > 0) {
        throw new ModelRouterError(
          `No available models for task '${task}': ${[...this.authTripped].join(', ')} failed sign-in earlier in this run`,
          'local_auth',
          [],
        );
      }
      throw new Error(`No available models for task '${task}'`);
    }

    const maxRetries = this.registry.failover.maxRetries;
    const cooldownMs = this.registry.failover.cooldownMs;
    const attempts: RouterAttempt[] = [];
    const blockedProviders = new Set<string>();
    const wtAtStart = worktreeExists(options.worktree); // #2964: only a worktree that existed can be "removed"
    const snapshot = taskRequiresAgenticHarness(task)
      ? await captureWorktreeState(this.gitExecFn, worktree, onLog)
      : null;

    let ollamaProbe: OllamaProbeResult | undefined;
    let skippedForOllama = false;
    let skippedForMissingCli = false;
    const missingClis: string[] = [];

    let ceilingNoticed = false;

    for (const model of models) {
      if (isOpenCodeZenModel(model, this.registry.get(model))) {
        if (model !== models[0]) {
          onLog(
            `provider_failover_zen_skip: skipping ${model} for ${task}: OpenCode Zen (opencode/) models are never failover targets`,
          );
          continue;
        }
        if (!this.meteredPrimaryNoticed.has(model)) {
          this.meteredPrimaryNoticed.add(model);
          onLog(
            `metered_primary_route: ${model} for ${task} is OpenCode Zen (metered pay-per-use); it runs only because it is the explicit primary`,
          );
        }
      }
      const modelProvider = this.registry.get(model)?.provider;
      if (modelProvider === 'ollama' && this.executor.probeOllama) {
        ollamaProbe ??= await this.executor.probeOllama();
        if (!ollamaProbe.reachable) {
          if (claimOllamaSkipNotice()) {
            onLog(`Skipping Ollama models: ${ollamaProbe.endpoint} unreachable (${ollamaProbe.reason})`);
          }
          skippedForOllama = true;
          continue;
        }
      }
      if (this.harnessCliMissing(model)) {
        this.noticeMissingHarness(model, onLog);
        skippedForMissingCli = true;
        const cmd = harnessCliCommand(this.registry.getHarnessId(model));
        if (cmd) missingClis.push(cmd);
        continue;
      }
      if (this.isAuthTripped(model)) {
        onLog(`Skipping ${model} for ${task}: ${this.authKey(model)} failed sign-in earlier in this run`);
        continue;
      }
      if (modelProvider && blockedProviders.has(modelProvider)) {
        onLog(`Skipping ${model} for ${task}: provider ${modelProvider} is on cooldown`);
        continue;
      }
      if (modelProvider && this.providerGate) {
        try {
          if (await this.providerGate(modelProvider)) {
            blockedProviders.add(modelProvider);
            onLog(
              `Skipping ${model} for ${task}: provider ${modelProvider} breaker is open until its credentials change`,
            );
            continue;
          }
        } catch {
          // a gate error never blocks a model
        }
      }
      let retries = 0;
      this.noticeRetiredHarness(model, onLog);

      while (retries <= maxRetries) {
        onLog(`Trying ${model} for ${task} (attempt ${retries + 1})`);

        let usage: HarnessUsage | undefined;
        let output: string;
        const attemptStartedAt = Date.now();
        const harnessId = this.registry.getHarnessId(model);
        if (!ceilingNoticed && taskRequiresAgenticHarness(task)) {
          ceilingNoticed = true;
          options.onContextCeiling?.(
            contextCeilingNotice(task, model, harnessId, this.contextCeilings, this.registry.get(model)?.contextWindow),
          );
        }
        const budget = options.budgetGuard ? watchBudget(this.registry, model, options.budgetGuard) : undefined;
        try {
          output = await this.executor.runModel(model, prompt, {
            worktree,
            timeoutSeconds,
            task,
            registry: this.registry,
            routesConfig: this.routesConfig,
            sandbox,
            ...this.codexWorkspacePaths,
            codexFullAccessTasks: this.codexFullAccessTasks,
            contextCeiling: contextCeilingFor(task, harnessId, this.contextCeilings),
            env,
            onPgid,
            onUsage: (u) => {
              usage = u;
            },
            onLiveUsage: budget?.onLiveUsage,
          });
          budget?.throwIfStopped();
        } catch (err) {
          if (budget?.stop) {
            const elapsed = Date.now() - attemptStartedAt;
            this.recordCost(task, model, prompt, '', undefined, retryCause, usage ?? budget.stop.usage, elapsed);
            throw new BudgetStopError(model, budget.stop, attempts);
          }
          if (sandbox && sandbox.runtime !== 'none') {
            const sandboxEvent = sandboxEventFromError(err);
            if (sandboxEvent) options.onSandboxEvent?.(sandboxEvent.type, sandboxEvent.detail);
          }
          const failure = providerFailureOf(err);
          const reason = failure.reason;
          const provider = this.registry.get(model)?.provider;
          const detail = describeFailureDetail(err);
          const blockProvider = async (): Promise<void> => {
            if (!provider || !opensProviderBreaker(failure)) return;
            blockedProviders.add(provider);
            try {
              await onProviderFailure?.({
                provider,
                reason,
                kind: failure.kind,
                ...(failure.resetAt ? { resetAt: failure.resetAt } : {}),
                detail: detail || undefined,
                model,
                ...(harnessId ? { harness: harnessId } : {}),
              });
            } catch (callbackErr) {
              onLog(
                `Provider breaker bookkeeping failed for ${provider} (${reason}); continuing failover: ${
                  callbackErr instanceof Error ? callbackErr.message : String(callbackErr)
                }`,
              );
            }
          };
          attempts.push(detail ? { model, reason, ok: false, detail } : { model, reason, ok: false });
          onLog(`${model} failed (${reason}) on ${task}`);
          await throwIfWorktreeMissing(task, options.worktree, model, attempts, onLog, blockProvider, wtAtStart);
          if (reason === 'local_auth') {
            const key = this.authKey(model);
            if (key !== undefined && !this.authTripped.has(key)) {
              this.authTripped.add(key);
              onLog(`${key} is not signed in; skipping it for the rest of this run`);
            }
            const agent = localAuthAgentFor(key);
            if (agent && this.localAuthSink) {
              try {
                this.localAuthSink(agent);
              } catch {
                // bookkeeping only
              }
            }
          }
          if (detail) onLog(`${model} failure detail on ${task}: ${detail}`);

          // Deterministic failure — another model cannot plausibly help; do not
          // burn the next tier. Reason + attempts are preserved for event logs.
          if (failure.kind === 'other') {
            await blockProvider();
            onLog(`${model} failed (${reason}) on ${task} — non-retryable, not failing over`);
            throw new ModelRouterError(
              `Non-retryable failure (${reason}) from ${model} for task '${task}'${detail ? `: ${detail}` : ''}`,
              reason,
              attempts,
            );
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
              throw new ModelRouterError(
                `Worktree reset failed after ${model} failure (${reason}) for task '${task}' — aborting failover to avoid mixing attempt state: ${message}`,
                'error',
                attempts,
              );
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
            await blockProvider();
            onLog(`Usage cap hit on ${model} — failing over to next model`);
            break;
          }

          // Timeout → failover
          if (reason === 'timeout') {
            await blockProvider();
            onLog(`${model} timed out on ${task} — failing over`);
            break;
          }

          // Generic error → retry once, then failover
          if (reason === 'error' && retries < 1) {
            retries++;
            continue;
          }

          await blockProvider();

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
          this.recordCost(
            task,
            model,
            prompt,
            output,
            failoverReason,
            retryCause,
            usage,
            Date.now() - attemptStartedAt,
          );
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
            throw new ModelRouterError(
              `Worktree reset failed after ${model} failure (empty_response) for task '${task}' — aborting failover to avoid mixing attempt state: ${message}`,
              'error',
              attempts,
            );
          }
        }
        break;
      }
    }

    if (attempts.length === 0 && skippedForMissingCli && !skippedForOllama) {
      const cmds = [...new Set(missingClis)].sort().join(', ');
      throw new ModelRouterError(
        `No runnable models for task '${task}': ${cmds} CLI not found on PATH`,
        'unavailable',
        attempts,
      );
    }
    if (attempts.length === 0 && skippedForOllama && ollamaProbe && !ollamaProbe.reachable) {
      throw new ModelRouterError(
        `No reachable models for task '${task}': Ollama at ${ollamaProbe.endpoint} unreachable (${ollamaProbe.reason})`,
        'unavailable',
        attempts,
      );
    }
    const summary = attempts.map((a) => `${a.model}(${a.reason}${a.detail ? `: ${a.detail}` : ''})`).join(', ');
    throw new ModelRouterError(
      `All models failed for task '${task}': ${summary}`,
      attempts[attempts.length - 1]?.reason ?? 'error',
      attempts,
    );
  }
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
