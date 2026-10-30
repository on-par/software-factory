// packages/cli/src/cli/test-support/cli-commands-state.ts — shared state and fakes for the cli command suites (#3809)
import { join } from 'node:path';

import type * as FactoryCore from '@on-par/factory-core';
import { vi } from 'vitest';

import { openPrFixture } from '../__fixtures__/open-pr.js';
import type { CliDeps } from '../index.js';

// ---------------------------------------------------------------------------
// Shared mutable state the fakes read from. Set per test by installCliCommandsHarness().
// ---------------------------------------------------------------------------
export const h = {
  repoRoot: '',
  constitutionsDir: '',
  // daemon-control seam (CliDeps.daemon)
  daemonHome: '',
  daemonPlatform: 'darwin' as NodeJS.Platform,
  daemonExecCalls: [] as Array<{ cmd: string; args: string[] }>,
  daemonExecImpl: (_cmd: string, _args: string[]) => ({ code: 0, stdout: '', stderr: '' }),
  daemonOut: [] as string[],
  ghRepo: 'on-par/software-factory',
  // shell seam (CliDeps.exec / execSync)
  execImpl: (_cmd: string): string => '',
  execSyncImpl: (_cmd: string): string => {
    throw new Error('execSync not stubbed');
  },
  claudeAvailable: undefined as boolean | undefined,
  dockerAvailable: undefined as boolean | undefined,
  sbxAvailable: undefined as boolean | undefined,
  orphanContainers: [] as Array<{ id: string; name: string }>,
  reapedContainers: [] as Array<{ id: string; name: string; removed: boolean; detail: string }>,
  orphanVmNames: [] as string[],
  reapedVms: [] as Array<{ name: string; removed: boolean; detail: string }>,
  // GitHub client injected through CliDeps.octokit
  octokit: {} as any,
  // configurable core behaviour
  constitutionResolve: (
    _worktree: string,
    _product?: string,
    _constitutionPath?: string,
    _mainCheckoutDir?: string,
  ): any => null,
  modelOverrides: {} as Record<string, string>,
  modelProviders: {} as Record<string, string>,
  triageCandidates: [] as string[],
  routerRun: (async (_task: string, _prompt: string, _opts?: any) => {
    throw new Error('router.run not scripted');
  }) as (task: string, prompt: string, opts?: any) => Promise<{ model: string; output: string }>,
  triggerPlanProviderFailure: null as { provider: string; reason: any; detail?: string } | null,
  planResult: { ok: true, route: 'claude' } as any,
  buildResult: { ok: true } as any,
  checkResult: { passed: true, summary: { results: [], failures: 0 }, reworkRounds: 0 } as any,
  orphanEvents: [] as any[],
  portListeners: [] as any[],
  shipResult: { ok: true, prNumber: 99 } as any,
  diagnoses: [] as any[],
  harnessProbes: [] as any[],
  costs: [] as any[],
  costSinkCallback: undefined as ((entry: any) => void) | undefined,
  trailingSpend: 10,
  subscriptionUsage: null as { fiveHourUtilization: number; fiveHourResetsAt: string | null } | null,
  routerResolve: (_route: string): string | undefined => 'claude-model',
  factoryConfig: {
    merge: { auto: false, comment: '' },
    worktree: { parent: '../', gcTtlDays: 7, autoGcOnRun: false },
    sandbox: {
      enabled: true,
      network: { allow: ['api.anthropic.com', 'github.com'] },
      resources: { cpuMs: 300_000, memMb: 4096 },
    },
    sweep: { loopIntervalSeconds: 300, staleThresholdMultiplier: 2 },
  } as any,
  gcReport: { removed: [], kept: 0, dryRun: false } as any,
  staleClaims: [] as any[],
  greenPrs: [] as any[],
  runTuiCalls: [] as Array<{
    eventsFile: string;
    repo?: string;
    stopFile?: string;
    queueReader?: {
      source: string;
      read: () => Promise<FactoryCore.QueueSnapshot> | FactoryCore.QueueSnapshot;
      pollMs?: number;
    };
    costsFile?: string;
    steeringDir?: string;
    runsDir?: string;
  }>,
  setupWorktreeImpl: async (_repoRoot: string, _branch: string, _worktree: string, _startPoint?: string) => {},
};

export class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

export const DEFAULT_CODE_FIXTURE =
  '---\nproduct: default-code\ncheckers: [compile]\n---\n# Default Code Constitution\n';

export const savedEnv: Record<string, string | undefined> = {};

export function trackEnv(...keys: string[]) {
  for (const k of keys) savedEnv[k] = process.env[k];
}

export function paths() {
  const root = join(h.repoRoot, '.factory');
  const state = join(root, 'state');
  return {
    root,
    state,
    queue: join(state, 'queue'),
    queueProposed: join(state, 'queue.proposed'),
    events: join(state, 'events.ndjson'),
    plans: join(state, 'plans'),
    product: join(state, 'product'),
    stop: join(state, 'STOP'),
    costs: join(state, 'costs.jsonl'),
    reports: join(state, 'reports'),
    runs: join(state, 'runs'),
    steering: join(state, 'steering'),
    kpiHistory: join(state, 'kpi-history.jsonl'),
    classifierOutcomes: join(state, 'classifier-outcomes.jsonl'),
    breaker: join(state, 'breaker.json'),
    baseHold: join(state, 'base-hold.json'),
    runFlags: join(state, 'run-flags.json'),
    mergeLock: join(state, 'merge.lock'),
    gitLock: join(state, 'git.lock'),
    config: join(root, 'config.json'),
    constitution: join(root, 'constitution.md'),
    gitignore: join(root, '.gitignore'),
  };
}

export function defaultOctokit() {
  return {
    paginate: async (fn: any, args: any) => (await fn(args)).data,
    rest: {
      issues: {
        get: vi.fn(async () => ({ data: { title: 'Fix the bug' } })),
        listForRepo: vi.fn(async () => ({ data: [] })),
        listLabelsOnIssue: vi.fn(async () => ({ data: [] })),
        listComments: vi.fn(async () => ({ data: [] })),
      },
      users: { getAuthenticated: vi.fn(async () => ({ data: { id: 7 } })) },
      rateLimit: { get: vi.fn(async () => ({ data: { resources: { core: { limit: 5000, remaining: 5000 } } } })) },
      pulls: {
        list: vi.fn(async ({ state, head }: any) => ({ data: state === 'open' ? [openPrFixture(head)] : [] })),
        get: vi.fn(async () => ({ data: { head: { sha: 'abc123' } } })),
        merge: vi.fn(async () => ({})),
      },
      git: { deleteRef: vi.fn(async () => ({})) },
      checks: { listForRef: vi.fn(async () => ({ data: { check_runs: [] } })) },
      search: { issuesAndPullRequests: vi.fn(async () => ({ data: { items: [] } })) },
    },
    graphql: vi.fn(async (query: string) =>
      query.trimStart().startsWith('query')
        ? { repository: { pullRequest: { id: 'PR_ID', isDraft: false, mergeStateStatus: 'CLEAN' } } }
        : {},
    ),
  };
}

/** Inert config loaders injected through the CliDeps seams (#2064, #2065). */
export const inertConfigLoaders: Pick<
  CliDeps,
  | 'loadModelsConfig'
  | 'loadRoutesConfig'
  | 'loadFactoryConfigForRepo'
  | 'resolveTimeouts'
  | 'resolveSkipCI'
  | 'getConstitutionsDir'
  | 'resolveEffectiveModelPins'
> = {
  loadModelsConfig: () => ({ models: {}, tiers: {} }) as never,
  loadRoutesConfig: () => ({}) as never,
  // Lazy: per-test h.factoryConfig mutations are observed.
  loadFactoryConfigForRepo: () => h.factoryConfig,
  resolveTimeouts: () => ({ plan: 1, build: 1, check: 1, approval: 1, tests: 1, compile: 1 }),
  resolveSkipCI: () => false,
  // Lazy: per-test h.constitutionsDir / h.modelOverrides mutations are observed.
  getConstitutionsDir: vi.fn(() => h.constitutionsDir),
  resolveEffectiveModelPins: vi.fn(() => ({
    plan: h.modelOverrides.plan,
    planFallback: h.modelOverrides.planFallback,
    build: h.modelOverrides.build,
    buildFallback: h.modelOverrides.buildFallback,
    sources: {},
  })) as never,
};

/** Git side-effect doubles injected through the CliDeps seams (#2019). setupWorktree delegates to h.setupWorktreeImpl. */
export const setupWorktree = vi.fn<NonNullable<CliDeps['setupWorktree']>>(async (...args) => {
  await h.setupWorktreeImpl(args[0], args[1], args[2], args[3]);
  return undefined as never;
});
export const cleanupWorktree = vi.fn(async (..._args: Parameters<NonNullable<CliDeps['cleanupWorktree']>>) => {});
export const gitFetch = vi.fn(async (_repoRoot: string) => {});
export const inertGitOps: Pick<CliDeps, 'setupWorktree' | 'cleanupWorktree' | 'gitFetch'> = {
  setupWorktree,
  cleanupWorktree,
  gitFetch,
};

export function makeInternalFakes() {
  return {
    watchChecks: vi.fn(async () => 'success') as any,
    createLocalSmallDryRun: vi.fn(async () => ({ planPath: '/tmp/plan.md', contextPath: '/tmp/ctx.md' })) as any,
    readCosts: vi.fn(() => h.costs) as any,
    sweepWorktrees: vi.fn(async () => h.gcReport) as any,
    releaseStaleClaims: vi.fn(async () => h.staleClaims) as any,
    findUnmergedGreenPrs: vi.fn(async () => h.greenPrs) as any,
    listOrphanContainers: vi.fn(async () => h.orphanContainers) as any,
    reapOrphanContainers: vi.fn(async () => h.reapedContainers) as any,
    listMicroVms: vi.fn(async () => h.orphanVmNames),
    reapOrphanMicroVm: vi.fn(
      async (name: string) =>
        h.reapedVms.find((r) => r.name === name) ?? { name, removed: true, detail: `sbx rm --force ${name} ok` },
    ) as any,
    formatGcReport: vi.fn(
      (report: any) =>
        `GC_REPORT:${report.dryRun ? 'dry' : 'real'}:removed=${report.removed.length}:kept=${report.kept}`,
    ),
    exec: vi.fn(async (cmd: string) => ({ stdout: h.execImpl(cmd), stderr: '' })),
    execSync: vi.fn((cmd: string) => h.execSyncImpl(cmd)),
    octokit: () => h.octokit,
  } satisfies Pick<
    CliDeps,
    | 'watchChecks'
    | 'createLocalSmallDryRun'
    | 'readCosts'
    | 'sweepWorktrees'
    | 'releaseStaleClaims'
    | 'findUnmergedGreenPrs'
    | 'listOrphanContainers'
    | 'reapOrphanContainers'
    | 'listMicroVms'
    | 'reapOrphanMicroVm'
    | 'formatGcReport'
    | 'exec'
    | 'execSync'
    | 'octokit'
  >;
}
/** Fresh fakes per test, spread into every main/shipIssue call. */
export let ops = makeInternalFakes();

export function makeCoreFakes() {
  return {
    isCommandAvailable: vi.fn((cmd: string) => {
      if (cmd === 'docker') return h.dockerAvailable ?? false;
      if (cmd === 'sbx') return h.sbxAvailable ?? false;
      return h.claudeAvailable ?? true;
    }),
    defaultFindPortListeners: vi.fn(async () => h.portListeners) as any,
    reapOrphanProcesses: vi.fn(async (opts: any) => {
      for (const e of h.orphanEvents) opts.onEvent?.(e);
      return h.orphanEvents;
    }) as any,
    // Router / loaders as light stubs.
    ModelRouter: vi.fn(function () {
      return {
        resolve: (route: string) => h.routerResolve(route),
        resolveAll: (_route: string) => h.triageCandidates,
        registryRef: {
          getClaudeFlag: () => '--flag',
          getModelsInTier: () => ['m'],
          get: (id: string) => (h.modelProviders[id] ? { provider: h.modelProviders[id] } : undefined),
          getHarnessId: (id: string) => (h.modelProviders[id] === 'anthropic' ? 'claude-cli' : 'codex-cli'),
          isCodexModel: (id: string) => h.modelProviders[id] === 'openai',
          getHarnessDeclaration: () => undefined,
          isAgenticHarnessId: () => true,
        },
        setCostSink: vi.fn((sink: (entry: any) => void) => {
          h.costSinkCallback = sink;
        }),
        skipMissingHarnessClis: vi.fn(),
        run: vi.fn(async (task: string, prompt: string, opts: any) => h.routerRun(task, prompt, opts)),
      };
    }) as any,
    ConstitutionLoader: vi.fn(function () {
      return {
        listProducts: () => ['alpha', 'beta'],
        load: (p: string) => ({ product: p, checkers: p === 'alpha' ? ['compile', 'lint'] : [] }),
        resolve: (...args: any[]) => (h.constitutionResolve as (...a: any[]) => any)(...args),
      };
    }) as any,
    ModelRegistry: vi.fn(function () {
      return {
        list: () => ['claude-model'],
        getTiers: () => ['worker'],
        estimateCost: () => ({ cost: 1.23, cachedRateMissing: false }),
        isExperimental: () => false,
        isAvailable: () => true,
        getModelsInTier: () => ['claude-model'],
      };
    }) as any,
    // Usage / reports.
    estimateTrailingSpend: vi.fn(() => h.trailingSpend) as any,
    formatUsageReport: vi.fn(() => 'USAGE REPORT'),
    watchUsage: vi.fn(async () => {}) as any,
    fetchSubscriptionUsage: vi.fn(async () => h.subscriptionUsage) as any,
    diagnoseModels: vi.fn(() => h.diagnoses) as any,
    probeDeclaredHarnesses: vi.fn(() => h.harnessProbes) as any,
    writeLocalRunReport: vi.fn(async () => ({ path: '/tmp/report.md' })) as any,
  } satisfies Pick<
    CliDeps,
    | 'ModelRouter'
    | 'ConstitutionLoader'
    | 'ModelRegistry'
    | 'isCommandAvailable'
    | 'defaultFindPortListeners'
    | 'reapOrphanProcesses'
    | 'estimateTrailingSpend'
    | 'formatUsageReport'
    | 'watchUsage'
    | 'fetchSubscriptionUsage'
    | 'diagnoseModels'
    | 'probeDeclaredHarnesses'
    | 'writeLocalRunReport'
  >;
}
/** Fresh fakes per test, spread into every main/shipIssue call. */
export let coreFakes = makeCoreFakes();

/**
 * Phase doubles. shipIssue builds ports and calls the real runIssue in @on-par/factory-core, which sequences
 * PLAN->BUILD->CHECK->SHIP, the breaker, budget assertions and constitution logging (#675). Only the four
 * phase functions are doubled, and they reach RunPorts through CliDeps phase overrides (ADR-0004).
 */
export function makePhaseFakes() {
  return {
    planPhase: vi.fn<NonNullable<CliDeps['planPhase']>>(async (opts) => {
      if (h.triggerPlanProviderFailure) await opts.onProviderFailure?.(h.triggerPlanProviderFailure);
      return h.planResult;
    }),
    buildPhase: vi.fn<NonNullable<CliDeps['buildPhase']>>(async (_opts) => h.buildResult),
    checkPhase: vi.fn<NonNullable<CliDeps['checkPhase']>>(async (opts) => {
      for (const s of h.checkResult.summary.results.filter((r: any) => r.result === 'SKIP')) {
        opts.log?.('check', `SKIPPED: ${s.checker} — ${s.details}`);
      }
      for (let i = 0; i < (h.checkResult.reworkRounds ?? 0); i++) {
        opts.log?.('rework', `rework round ${i + 1}`);
      }
      h.costSinkCallback?.({ task: 'build', model: 'claude-model', inputTokens: 10, outputTokens: 5, cost: 0.02 });
      return h.checkResult;
    }),
    shipPhase: vi.fn<NonNullable<CliDeps['shipPhase']>>(async (_opts) => h.shipResult),
    checkBaseHealth: vi.fn<NonNullable<CliDeps['checkBaseHealth']>>(async () => ({
      kind: 'skipped' as const,
      failingChecks: [],
      cached: false,
    })),
  } satisfies Pick<CliDeps, 'planPhase' | 'buildPhase' | 'checkPhase' | 'shipPhase' | 'checkBaseHealth'>;
}
/** Fresh phase doubles per test, spread into every main/shipIssue call (CliDeps phase overrides). */
export let phases = makePhaseFakes();

export function resetFakes(): void {
  ops = makeInternalFakes();
  coreFakes = makeCoreFakes();
  phases = makePhaseFakes();
}
