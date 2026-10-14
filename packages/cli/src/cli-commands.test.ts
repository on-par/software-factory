import type * as ChildProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

import * as FactoryCore from '@on-par/factory-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mutable state the hoisted mocks read from. Set per test in beforeEach.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  return {
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
});

import { listBuiltInCheckers } from '@on-par/factory-core/internal';

import { FACTORYD_LABEL, factorydFiles, type DaemonCtlDeps } from './cli/daemon.js';
import { HELP_GROUPS, OTHER_GROUP } from './cli/help-groups.js';

import {
  buildInitConfig,
  type CliDeps,
  CliExitError,
  cmdConstitution,
  cmdUsage as cliCmdUsage,
  formatInitReachability,
  LaneParkError,
  LaneEnvironmentPauseError,
  ghRepoViewFailureMessage,
  main,
  parseIssueArg,
  shipIssue as cliShipIssue,
} from './cli/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let exitSpy: any;
let logSpy: any;
let errSpy: any;
const DEFAULT_CODE_FIXTURE = '---\nproduct: default-code\ncheckers: [compile]\n---\n# Default Code Constitution\n';

const savedEnv: Record<string, string | undefined> = {};

function trackEnv(...keys: string[]) {
  for (const k of keys) savedEnv[k] = process.env[k];
}

function paths() {
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

function defaultOctokit() {
  return {
    rest: {
      issues: {
        get: vi.fn(async () => ({ data: { title: 'Fix the bug' } })),
        listForRepo: vi.fn(async () => ({ data: [] })),
        listLabelsOnIssue: vi.fn(async () => ({ data: [] })),
        listComments: vi.fn(async () => ({ data: [] })),
      },
      users: { getAuthenticated: vi.fn(async () => ({ data: { id: 7 } })) },
      pulls: {
        list: vi.fn(async ({ state }: any) =>
          state === 'open'
            ? { data: [{ number: 77, head: { ref: 'ship-it/5-fix-the-bug' }, body: 'Closes #5' }] }
            : { data: [] },
        ),
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
const inertConfigLoaders: Pick<
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
  resolveTimeouts: () => ({ plan: 1, build: 1, check: 1, approval: 1, tests: 1 }),
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
const setupWorktree = vi.fn(async (...args: Parameters<NonNullable<CliDeps['setupWorktree']>>) => {
  await h.setupWorktreeImpl(args[0], args[1], args[2], args[3]);
  return undefined as never;
});
const cleanupWorktree = vi.fn(async (..._args: Parameters<NonNullable<CliDeps['cleanupWorktree']>>) => {});
const gitFetch = vi.fn(async (_repoRoot: string) => {});
const inertGitOps: Pick<CliDeps, 'setupWorktree' | 'cleanupWorktree' | 'gitFetch'> = {
  setupWorktree,
  cleanupWorktree,
  gitFetch,
};

function makeInternalFakes() {
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
let ops = makeInternalFakes();

function makeCoreFakes() {
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
        estimateCost: () => 1.23,
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
let coreFakes = makeCoreFakes();

/**
 * Phase doubles. shipIssue builds ports and calls the real runIssue in @on-par/factory-core, which sequences
 * PLAN->BUILD->CHECK->SHIP, the breaker, budget assertions and constitution logging (#675). Only the four
 * phase functions are doubled, and they reach RunPorts through CliDeps phase overrides (ADR-0004).
 */
function makePhaseFakes() {
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
let phases = makePhaseFakes();

/** Direct shipIssue calls get the inert models/routes loaders unless a test passes its own. */
function shipIssue(...[issueNum, opts, ctx, deps]: Parameters<typeof cliShipIssue>) {
  return cliShipIssue(issueNum, opts, ctx, {
    ...inertConfigLoaders,
    ...inertGitOps,
    ...coreFakes,
    ...ops,
    ...phases,
    ...deps,
  });
}

/** Direct cmdUsage calls get shell + core fakes so they never run real git/subscription ops. */
function cmdUsage(deps: Parameters<typeof cliCmdUsage>[0] = {}) {
  return cliCmdUsage({ ...ops, ...coreFakes, ...deps });
}

const recordingRunTui: NonNullable<CliDeps['runTui']> = async (opts) => {
  h.runTuiCalls.push(opts);
};

function daemonDeps(): DaemonCtlDeps {
  return {
    exec: async (cmd, args) => {
      h.daemonExecCalls.push({ cmd, args });
      return h.daemonExecImpl(cmd, args);
    },
    home: h.daemonHome,
    uid: 501,
    platform: h.daemonPlatform,
    out: { write: (s: string) => h.daemonOut.push(s) },
    nodePath: '/usr/local/bin/node',
    cliScriptPath: '/opt/factory/cli.js',
    registryFile: join(h.daemonHome, '.factory', 'registry.json'),
    pollMs: 10,
  };
}

async function runMain(...args: string[]) {
  process.argv = ['node', 'factory', ...args];
  return runMainWith({ daemon: daemonDeps(), runTui: recordingRunTui }, ...args);
}

async function runMainWith(deps: CliDeps | undefined, ...args: string[]) {
  return runMainRaw({ ...inertConfigLoaders, ...deps }, ...args);
}

async function runMainRaw(deps: CliDeps | undefined, ...args: string[]) {
  try {
    await main(['node', 'factory', ...args], { ...inertGitOps, ...coreFakes, ...ops, ...phases, ...deps });
  } catch (err) {
    if (err instanceof ExitError) return { exited: true as const, code: err.code };
    throw err;
  }
  const code = process.exitCode as number | undefined;
  process.exitCode = undefined;
  return code === undefined ? { exited: false as const, code: undefined } : { exited: true as const, code };
}

beforeEach(() => {
  ops = makeInternalFakes();
  coreFakes = makeCoreFakes();
  phases = makePhaseFakes();
  h.repoRoot = mkdtempSync(join(tmpdir(), 'factory-cli-'));
  h.constitutionsDir = mkdtempSync(join(tmpdir(), 'factory-const-'));
  h.daemonHome = mkdtempSync(join(tmpdir(), 'factory-daemon-home-'));
  h.daemonPlatform = 'darwin';
  h.daemonExecCalls = [];
  h.daemonExecImpl = () => ({ code: 0, stdout: '', stderr: '' });
  h.daemonOut = [];
  mkdirSync(join(h.repoRoot, '.git', 'info'), { recursive: true });
  mkdirSync(paths().state, { recursive: true });
  mkdirSync(paths().plans, { recursive: true });

  h.execImpl = (cmd: string) => {
    if (cmd.includes('rev-parse')) return h.repoRoot;
    if (cmd.includes('gh repo view')) return h.ghRepo;
    return '';
  };
  h.execSyncImpl = (_cmd: string) => {
    throw new Error('no cli available');
  };
  h.octokit = defaultOctokit();
  h.constitutionResolve = () => null;
  h.modelOverrides = {};
  h.modelProviders = {};
  h.triageCandidates = [];
  h.routerRun = async () => {
    throw new Error('router.run not scripted');
  };
  h.triggerPlanProviderFailure = null;
  h.planResult = { ok: true, route: 'claude' };
  h.buildResult = { ok: true };
  h.checkResult = { passed: true, summary: { results: [], failures: 0 }, reworkRounds: 0 };
  h.shipResult = { ok: true, prNumber: 99 };
  h.diagnoses = [];
  h.harnessProbes = [];
  h.costs = [];
  h.trailingSpend = 10;
  h.subscriptionUsage = null;
  h.routerResolve = () => 'claude-model';
  h.factoryConfig = {
    merge: { auto: false, comment: '' },
    worktree: { parent: '../', gcTtlDays: 7, autoGcOnRun: false },
    sandbox: {
      enabled: true,
      network: { allow: ['api.anthropic.com', 'github.com'] },
      resources: { cpuMs: 300_000, memMb: 4096 },
    },
    sweep: { loopIntervalSeconds: 300, staleThresholdMultiplier: 2 },
  };
  h.gcReport = { removed: [], kept: 0, dryRun: false };
  h.staleClaims = [];
  h.greenPrs = [];
  h.runTuiCalls = [];
  h.setupWorktreeImpl = async () => {};
  h.claudeAvailable = undefined;
  h.dockerAvailable = undefined;
  h.sbxAvailable = undefined;
  h.orphanContainers = [];
  h.reapedContainers = [];
  h.orphanVmNames = [];
  h.reapedVms = [];
  h.orphanEvents = [];
  h.portListeners = [];

  [
    'FACTORY_LOCAL_ONLY',
    'FACTORY_MERGE',
    'FACTORY_MERGE_ADMIN',
    'FACTORY_SKIP_CI',
    'FACTORY_USAGE_CAP',
    'FACTORY_STOP_AT',
    'FACTORY_RESUME_AT',
    'FACTORY_USAGE_POLL',
    'FACTORY_USAGE_WATCH',
    'FACTORY_USAGE_ESTIMATOR',
    'FACTORY_SANDBOX',
    'FACTORY_PLAN_MODEL',
    'FACTORY_BUILD_MODEL',
    'FACTORY_AUTO_FAILOVER',
    'FACTORY_FAILOVER_COOLDOWN_MINUTES',
    'FACTORY_FAILOVER_MODEL',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'TMUX',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  ].forEach((k) => trackEnv(k));
  // `factory run` and `factory supervise` probe the macOS login keychain before
  // claiming work, and abort when the probe fails inside tmux (#1014). The probe's
  // outcome depends on these ambient variables, so a suite launched from a tmux
  // pane on the Mini (the factory's own lanes, or a developer shell) aborted every
  // run/supervise test while the same suite passed on Linux CI and outside tmux.
  // The keychain preflight tests set them explicitly; everything else must not
  // inherit them from the host.
  delete process.env.TMUX;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  delete process.env.FACTORY_LOCAL_ONLY;
  delete process.env.FACTORY_MERGE;
  delete process.env.FACTORY_MERGE_ADMIN;
  delete process.env.FACTORY_SANDBOX;
  delete process.env.FACTORY_USAGE_WATCH;
  delete process.env.FACTORY_PLAN_MODEL;
  delete process.env.FACTORY_BUILD_MODEL;
  delete process.env.FACTORY_AUTO_FAILOVER;
  delete process.env.FACTORY_FAILOVER_COOLDOWN_MINUTES;
  delete process.env.FACTORY_FAILOVER_MODEL;
  delete process.env.GITHUB_TOKEN;
  process.env.GH_TOKEN = 'test-token';
  process.exitCode = undefined;

  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as any);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(h.repoRoot, { recursive: true, force: true });
  rmSync(h.constitutionsDir, { recursive: true, force: true });
  rmSync(h.daemonHome, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.exitCode = undefined;
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  vi.clearAllMocks();
});

function logged(): string {
  return logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
}
function errored(): string {
  return errSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
}

// ===========================================================================
describe('self-update', () => {
  const install = {
    version: '0.9.0',
    env: {},
    execPath: '/usr/local/bin/node',
    cliPath: '/usr/local/lib/node_modules/@on-par/factory-cli/dist/cli.js',
    exists: () => false,
  };

  it('--check --json prints the result and exits 10 when an update is available', async () => {
    const out: string[] = [];
    const res = await runMainWith(
      {
        selfUpdate: {
          fetch: async () => ({ status: 200, body: '{"latest":"0.9.1"}' }),
          install,
          out: { write: (s: string) => out.push(s) },
        },
      },
      'self-update',
      '--check',
      '--json',
    );
    expect(res.code).toBe(10);
    expect(JSON.parse(out.join(''))).toMatchObject({ updateAvailable: true, candidate: '0.9.1' });
  });

  it('exits 2 without --check', async () => {
    const res = await runMain('self-update');
    expect(res.code).toBe(2);
  });
});

describe('cli commands (via main dispatch)', () => {
  describe('overview (bare factory)', () => {
    it('prints the designed overview and does not call process.exit', async () => {
      const res = await runMain();
      expect(res.exited).toBe(false);
      const out = logged();
      expect(out).toContain('factory — ship verified GitHub issues autonomously');
      expect(out).toContain('factory ship <issue>');
    });
  });

  describe('init', () => {
    beforeEach(() => {
      writeFileSync(
        join(h.constitutionsDir, '_template.md'),
        '```markdown\n---\nproduct: <product-name>\n---\n# <Product> Constitution\n```\n',
      );
      writeFileSync(join(h.constitutionsDir, 'default-code.md'), DEFAULT_CODE_FIXTURE);
    });

    it("scaffolds the active product's bundled constitution when state/product names one", async () => {
      writeFileSync(join(h.constitutionsDir, 'alpha.md'), '# alpha constitution\n');
      mkdirSync(dirname(paths().product), { recursive: true });
      writeFileSync(paths().product, 'alpha');
      const res = await runMain('init');
      expect(res.exited).toBe(false);
      expect(readFileSync(paths().constitution, 'utf-8')).toBe('# alpha constitution\n');
    });

    it('ends with a Next hint that recommends factory doctor, then factory triage, with --product optional', async () => {
      const res = await runMain('init');
      expect(res.exited).toBe(false);
      const out = logged();
      expect(out).toContain(
        'Next: factory doctor, then factory triage (optional: factory constitution --product <name> to swap the default constitution)',
      );
      expect(out).not.toContain('Next: factory constitution --product <name>, then factory triage');
      expect(out.trimEnd().split('\n').at(-1)).toMatch(/^Next: factory doctor, then factory triage/);
    });

    it('does not run `ollama list` when ollama is not on PATH', async () => {
      coreFakes.isCommandAvailable.mockImplementation((c: string) => c !== 'ollama');
      const cmds: string[] = [];
      const prev = h.execSyncImpl;
      h.execSyncImpl = (cmd: string) => {
        cmds.push(cmd);
        if (cmd === 'ollama list') throw new Error('/bin/sh: 1: ollama: not found');
        return prev(cmd);
      };
      const res = await runMain('init');
      expect(res.exited).toBe(false);
      expect(cmds).not.toContain('ollama list');
      for (const text of [logged(), errored()]) {
        expect(text).not.toMatch(/\/bin\/sh/);
        expect(text).not.toMatch(/not found/);
        expect(text).not.toMatch(/ollama/i);
      }
    });

    it('runs `ollama list` unchanged when ollama is on PATH', async () => {
      const prev = h.execSyncImpl;
      h.execSyncImpl = (cmd: string) => (cmd === 'ollama list' ? 'NAME ID SIZE MODIFIED\n' : prev(cmd));
      const res = await runMain('init');
      expect(res.exited).toBe(false);
      expect(ops.execSync).toHaveBeenCalledWith('ollama list', { timeout: 10_000 });
      const out = logged();
      expect(out).toContain('policy=auto');
      expect(out).toContain('Initialized');
      expect(out).toContain('Next: factory doctor');
    });

    it('creates .factory dirs, the git exclude entry, and a sample queue', async () => {
      const res = await runMain('init');
      expect(res.exited).toBe(false);
      expect(existsSync(paths().queue)).toBe(true);
      const exclude = readFileSync(join(h.repoRoot, '.git/info/exclude'), 'utf-8');
      expect(exclude).toContain('.factory/');
      expect(logged()).toContain('Initialized');
    });

    it('does not duplicate the exclude entry or clobber an existing queue', async () => {
      writeFileSync(join(h.repoRoot, '.git/info/exclude'), '.factory/\n');
      writeFileSync(paths().queue, 'app 1\n');
      await runMain('init');
      const exclude = readFileSync(join(h.repoRoot, '.git/info/exclude'), 'utf-8');
      expect(exclude.match(/\.factory\//g)).toHaveLength(1);
      expect(readFileSync(paths().queue, 'utf-8')).toBe('app 1\n');
    });

    it('warns with the missing-token message but still initializes when no token source is available', async () => {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      h.execSyncImpl = (cmd: string) => {
        if (cmd.includes('gh auth token')) throw new Error('not authenticated');
        return '';
      };
      const res = await runMain('init');
      expect(res.exited).toBe(false);
      expect(errored()).toContain('factory: warning: GITHUB_TOKEN not set — create a token at');
      expect(existsSync(paths().queue)).toBe(true);
      expect(logged()).toContain('Initialized');
    });

    it('succeeds when GH_TOKEN is set even without GITHUB_TOKEN', async () => {
      delete process.env.GITHUB_TOKEN;
      process.env.GH_TOKEN = 'test-token';
      const res = await runMain('init');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('Initialized');
    });

    it('writes config.yaml, constitution.md, and .gitignore, then prints a reachability summary', async () => {
      h.diagnoses = [
        { reachable: true, tiers: ['worker'] } as any,
        { reachable: true, tiers: ['worker'] } as any,
        { reachable: false, tiers: ['worker'] } as any,
      ];
      const res = await runMain('init');
      expect(res.exited).toBe(false);

      const yamlConfig = join(h.repoRoot, '.factory', 'config.yaml');
      expect(existsSync(yamlConfig)).toBe(true);
      const text = readFileSync(yamlConfig, 'utf-8');
      expect(text.startsWith('#')).toBe(true);
      expect(text).toContain('version: 2');

      expect(existsSync(paths().constitution)).toBe(true);
      const constitution = readFileSync(paths().constitution, 'utf-8');
      expect(constitution).toBe(DEFAULT_CODE_FIXTURE);

      expect(existsSync(paths().gitignore)).toBe(true);
      expect(readFileSync(paths().gitignore, 'utf-8')).toContain('state/');

      expect(logged()).toContain('policy=auto,');
      expect(logged()).toContain('models reachable');
    });

    it('is idempotent: a second run without --force leaves an existing config untouched', async () => {
      const sentinel = '{"version":2,"models":{"pins":{"plan":"x"}}}';
      writeFileSync(paths().config, sentinel);
      await runMain('init');
      expect(readFileSync(paths().config, 'utf-8')).toBe(sentinel);
      expect(logged()).toContain('leaving as-is');
    });

    it('--force overwrites an existing config', async () => {
      writeFileSync(paths().config, '{"version":2,"models":{"pins":{"plan":"x"}}}');
      await runMain('init', '--force');
      expect(readFileSync(paths().config, 'utf-8')).toBe(buildInitConfig('json'));
    });

    it('leaves .factory/ git-clean except the committed config, constitution, .gitignore, and the state/ directory', async () => {
      await runMain('init');
      writeFileSync(paths().queue, 'app 1\n');

      expect(readdirSync(paths().root).sort()).toEqual(
        ['.gitignore', 'config.yaml', 'constitution.md', 'state'].sort(),
      );
    });
  });

  describe('buildInitConfig', () => {
    it('defaults to a YAML header comment plus version: 2', () => {
      const text = buildInitConfig();
      expect(text.startsWith('#')).toBe(true);
      expect(text).toContain('version: 2\n');
    });

    it('returns valid pin-free version-2 JSON for json', () => {
      const parsed = JSON.parse(buildInitConfig('json'));
      expect(parsed).toEqual({ version: 2 });
      expect(parsed.models).toBeUndefined();
      expect(parsed.tiers).toBeUndefined();
    });
  });

  describe('formatInitReachability', () => {
    it('renders policy=auto, K/N models reachable', () => {
      const diagnoses = [{ reachable: true } as any, { reachable: true } as any, { reachable: false } as any];
      expect(formatInitReachability(diagnoses)).toBe('policy=auto, 2/3 models reachable');
    });
  });

  describe('formatInitReachability unverified', () => {
    it('counts reachable models and reports unverified ones separately', () => {
      const diagnoses = [
        { reachable: true } as any,
        { reachable: false, unverified: true } as any,
        { reachable: false } as any,
      ];
      expect(formatInitReachability(diagnoses)).toBe(
        'policy=auto, 1/3 models reachable, 1 unverified (no auth evidence)',
      );
    });
  });

  describe('init and models --doctor parity', () => {
    it('prints the same reachable count as models --doctor and passes the same probes', async () => {
      writeFileSync(
        join(h.constitutionsDir, '_template.md'),
        '```markdown\n---\nproduct: <product-name>\n---\n# <Product> Constitution\n```\n',
      );
      writeFileSync(join(h.constitutionsDir, 'default-code.md'), DEFAULT_CODE_FIXTURE);
      h.diagnoses = [
        {
          model: 'a',
          provider: 'anthropic',
          tiers: ['worker'],
          reachable: false,
          unverified: true,
          experimental: false,
          reason: 'r',
        },
        {
          model: 'b',
          provider: 'openai',
          tiers: ['worker'],
          reachable: false,
          unverified: true,
          experimental: false,
          reason: 'r',
        },
        { model: 'c', provider: 'ollama', tiers: ['worker'], reachable: true, experimental: false, reason: 'ok' },
      ] as any[];
      const count = '1/3 models reachable, 2 unverified (no auth evidence)';
      await runMain('init');
      expect(logged()).toContain(count);
      expect(coreFakes.diagnoseModels).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ ollamaModelPresent: undefined }),
        expect.anything(),
        expect.anything(),
      );
      logSpy.mockClear();
      await runMain('models', '--doctor');
      expect(logged()).toContain(count);
      expect(coreFakes.diagnoseModels).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ ollamaModelPresent: undefined }),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('constitution', () => {
    it('scaffolds .factory/constitution.md with --init <product>, never touching getConstitutionsDir()', async () => {
      writeFileSync(
        join(h.constitutionsDir, '_template.md'),
        '```markdown\n---\nproduct: <product-name>\n---\n# <Product> Constitution\n```\n',
      );
      const before = readdirSync(h.constitutionsDir);
      const res = await runMain('constitution', '--init', 'gizmo');
      expect(res.exited).toBe(false);
      expect(existsSync(paths().constitution)).toBe(true);
      expect(readFileSync(paths().constitution, 'utf-8')).toContain('product: "gizmo"');
      expect(readFileSync(paths().constitution, 'utf-8')).toContain('# Gizmo Constitution');
      // Regression (#1299): --init must never write into getConstitutionsDir().
      expect(readdirSync(h.constitutionsDir)).toEqual(before);
    });

    it('writes constitution to target repo when --init is given with no product', async () => {
      writeFileSync(
        join(h.constitutionsDir, '_template.md'),
        '```markdown\n---\nproduct: <product-name>\n---\n# <Product> Constitution\n```\n',
      );
      const before = readdirSync(h.constitutionsDir);
      const res = await runMain('constitution', '--init');
      expect(res.exited).toBe(false);
      expect(existsSync(paths().constitution)).toBe(true);
      expect(readFileSync(paths().constitution, 'utf-8')).toContain(basename(h.repoRoot));
      // Regression (#1299): --init must never write into getConstitutionsDir().
      expect(readdirSync(h.constitutionsDir)).toEqual(before);
    });

    it('creates .factory/ when missing before a bare --init', async () => {
      rmSync(paths().root, { recursive: true, force: true });
      writeFileSync(
        join(h.constitutionsDir, '_template.md'),
        '```markdown\n---\nproduct: <product-name>\n---\n# <Product> Constitution\n```\n',
      );
      expect(existsSync(paths().root)).toBe(false);
      const res = await runMain('constitution', '--init');
      expect(res.exited).toBe(false);
      expect(existsSync(paths().root)).toBe(true);
      expect(existsSync(paths().constitution)).toBe(true);
    });

    it('refuses overwrite of an existing repo constitution without --force', async () => {
      writeFileSync(
        join(h.constitutionsDir, '_template.md'),
        '```markdown\n---\nproduct: <product-name>\n---\n# <Product> Constitution\n```\n',
      );
      writeFileSync(paths().constitution, 'existing content');
      const res = await runMain('constitution', '--init');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('already exists');
      expect(readFileSync(paths().constitution, 'utf-8')).toBe('existing content');
    });

    it('refuses overwrite of an existing repo constitution with a named --init', async () => {
      writeFileSync(
        join(h.constitutionsDir, '_template.md'),
        '```markdown\n---\nproduct: <product-name>\n---\n# <Product> Constitution\n```\n',
      );
      writeFileSync(paths().constitution, 'existing content');
      const res = await runMain('constitution', '--init', 'gizmo');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('already exists');
      expect(readFileSync(paths().constitution, 'utf-8')).toBe('existing content');
    });

    it('force overwrite replaces an existing repo constitution when --force is passed', async () => {
      writeFileSync(
        join(h.constitutionsDir, '_template.md'),
        '```markdown\n---\nproduct: <product-name>\n---\n# <Product> Constitution\n```\n',
      );
      writeFileSync(paths().constitution, 'existing content');
      const res = await runMain('constitution', '--init', '--force');
      expect(res.exited).toBe(false);
      expect(readFileSync(paths().constitution, 'utf-8')).toContain(basename(h.repoRoot));
    });

    it('exits 2 when --init gets an invalid product name', async () => {
      const res = await runMain('constitution', '--init', '../evil');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('invalid product name');
    });

    it('lists products with --list', async () => {
      await runMain('constitution', '--list');
      expect(logged()).toContain('alpha');
      expect(logged()).toContain('beta');
    });

    it('--list prints each product with its checkers', async () => {
      await runMain('constitution', '--list');
      expect(logged()).toContain('alpha — compile, lint');
      expect(logged()).toContain('beta — (no checkers)');
    });

    it('--checkers prints every built-in checker with a description', async () => {
      const res = await runMain('constitution', '--checkers');
      expect(res.exited).toBe(false);
      const out = logged();
      for (const c of listBuiltInCheckers()) expect(out).toContain(`${c.name} — ${c.description}`);
      expect(out).toContain('custom_<name>');
    });

    it('--product overwrites the unmodified init scaffold without --force', async () => {
      writeFileSync(join(h.constitutionsDir, 'default-code.md'), DEFAULT_CODE_FIXTURE);
      writeFileSync(join(h.constitutionsDir, 'alpha.md'), '# alpha constitution\n');
      await runMain('init');
      const res = await runMain('constitution', '--product', 'alpha');
      expect(res.exited).toBe(false);
      expect(readFileSync(paths().constitution, 'utf-8')).toBe('# alpha constitution\n');
      expect(readFileSync(paths().product, 'utf-8')).toBe('alpha');
    });

    it('--product overwrites the legacy template scaffold without --force', async () => {
      writeFileSync(
        join(h.constitutionsDir, '_template.md'),
        '```markdown\n---\nproduct: <product-name>\n---\n# <Product> Constitution\n```\n',
      );
      writeFileSync(join(h.constitutionsDir, 'alpha.md'), '# alpha constitution\n');
      await runMain('constitution', '--init');
      const res = await runMain('constitution', '--product', 'alpha');
      expect(res.exited).toBe(false);
      expect(readFileSync(paths().constitution, 'utf-8')).toBe('# alpha constitution\n');
    });

    it('--product still refuses a user-edited constitution without --force', async () => {
      writeFileSync(join(h.constitutionsDir, 'default-code.md'), DEFAULT_CODE_FIXTURE);
      writeFileSync(join(h.constitutionsDir, 'alpha.md'), '# alpha constitution\n');
      await runMain('init');
      appendFileSync(paths().constitution, '\nMy own rule.\n');
      const before = readFileSync(paths().constitution, 'utf-8');
      const res = await runMain('constitution', '--product', 'alpha');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('already exists');
      expect(readFileSync(paths().constitution, 'utf-8')).toBe(before);
    });

    it('sets the active product when the constitution exists', async () => {
      writeFileSync(join(h.constitutionsDir, 'alpha.md'), '# alpha');
      const res = await runMain('constitution', '--product', 'alpha');
      expect(res.exited).toBe(false);
      expect(readFileSync(paths().product, 'utf-8')).toBe('alpha');
      expect(logged()).toContain('Active product: alpha');
    });

    it('exits 1 for --product on a missing constitution', async () => {
      const res = await runMain('constitution', '--product', 'nope');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain("No constitution 'nope'");
      expect(errored()).toContain('Available products: alpha, beta');
      expect(existsSync(paths().constitution)).toBe(false);
      expect(existsSync(paths().product)).toBe(false);
    });

    it('copies the bundled markdown for --product into the repo constitution.md', async () => {
      writeFileSync(join(h.constitutionsDir, 'alpha.md'), '# alpha constitution\n');
      const before = readdirSync(h.constitutionsDir);
      const res = await runMain('constitution', '--product', 'alpha');
      expect(res.exited).toBe(false);
      expect(readFileSync(paths().constitution, 'utf-8')).toBe('# alpha constitution\n');
      expect(readFileSync(paths().product, 'utf-8')).toBe('alpha');
      // --product must never write into getConstitutionsDir(), mirroring --init (#1299).
      expect(readdirSync(h.constitutionsDir)).toEqual(before);
    });

    it('refuses to overwrite an existing repo constitution.md with --product and no --force', async () => {
      writeFileSync(join(h.constitutionsDir, 'alpha.md'), '# alpha constitution\n');
      writeFileSync(paths().constitution, 'existing content');
      const res = await runMain('constitution', '--product', 'alpha');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('already exists');
      expect(readFileSync(paths().constitution, 'utf-8')).toBe('existing content');
      expect(existsSync(paths().product)).toBe(false);
    });

    it('overwrites an existing repo constitution.md with --product --force', async () => {
      writeFileSync(join(h.constitutionsDir, 'alpha.md'), '# alpha constitution\n');
      writeFileSync(paths().constitution, 'existing content');
      const res = await runMain('constitution', '--product', 'alpha', '--force');
      expect(res.exited).toBe(false);
      expect(readFileSync(paths().constitution, 'utf-8')).toBe('# alpha constitution\n');
      expect(readFileSync(paths().product, 'utf-8')).toBe('alpha');
    });

    it('overwrites .factory/state/product when --product is run again with a different name', async () => {
      writeFileSync(join(h.constitutionsDir, 'alpha.md'), '# alpha constitution\n');
      writeFileSync(join(h.constitutionsDir, 'beta.md'), '# beta constitution\n');
      const first = await runMain('constitution', '--product', 'alpha');
      expect(first.exited).toBe(false);
      expect(readFileSync(paths().product, 'utf-8')).toBe('alpha');

      const second = await runMain('constitution', '--product', 'beta', '--force');
      expect(second.exited).toBe(false);
      expect(readFileSync(paths().product, 'utf-8')).toBe('beta');
    });

    it('exits 2 with a usage line when no sub-option is given', async () => {
      const res = await runMain('constitution');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('usage: factory constitution');
    });

    it('rethrows an unexpected scaffolding error uncaught (not a CliExitError)', async () => {
      writeFileSync(join(h.constitutionsDir, '_template.md'), 'no markdown skeleton block here');
      await expect(runMain('constitution', '--init', 'gizmo')).rejects.toThrow(
        'constitution template is missing its ```markdown skeleton block',
      );
    });

    it('--help documents .factory/constitution.md as the source of truth and --product seeding', async () => {
      const originalWrite = process.stdout.write.bind(process.stdout);
      const written: string[] = [];
      process.stdout.write = ((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;

      let res: Awaited<ReturnType<typeof runMain>>;
      try {
        res = await runMain('constitution', '--help');
      } finally {
        process.stdout.write = originalWrite;
      }

      expect(res.exited).toBe(true);
      const text = written.join('').replace(/\s+/g, ' ');
      expect(text).toContain('.factory/constitution.md in this repo is the source of truth');
      expect(text).toContain('Seed .factory/constitution.md from the bundled constitution for <name>');
    });
  });

  describe('models', () => {
    it('uses an injected loadModelsConfig instead of the factory-core loader', async () => {
      const config = { models: { 'distinctive-model-2063': {} }, tiers: {} };
      const stub = vi.fn(() => config as never);

      await runMainWith({ daemon: daemonDeps(), runTui: recordingRunTui, loadModelsConfig: stub }, 'models');

      expect(stub).toHaveBeenCalled();
      expect(coreFakes.ModelRegistry.mock.calls.at(-1)?.[0]).toMatchObject({
        models: { 'distinctive-model-2063': {} },
      });
    });

    it('uses the factory-core loadModelsConfig when none is injected', async () => {
      await runMainRaw({ daemon: daemonDeps(), runTui: recordingRunTui }, 'models');
      const arg = coreFakes.ModelRegistry.mock.calls.at(-1)?.[0] as { models: object };
      expect(Object.keys(arg.models).length).toBeGreaterThan(0);
    });

    it('restores the default loaders after main() returns', async () => {
      const stub = vi.fn((repoRoot: string, stateRoot?: string) => FactoryCore.loadRepoConfig(repoRoot, stateRoot));
      await runMainWith({ daemon: daemonDeps(), runTui: recordingRunTui, loadRepoConfig: stub as never }, 'models');
      const stubCalls = stub.mock.calls.length;

      await shipIssue(5, {}, { repoRoot: h.repoRoot, ghRepo: h.ghRepo });

      expect(stub.mock.calls.length).toBe(stubCalls);
    });

    it('restores the default phases after main() returns', async () => {
      const stub = vi.fn(async () => h.planResult) as never;
      await runMainWith({ daemon: daemonDeps(), runTui: recordingRunTui, planPhase: stub }, 'models');

      await shipIssue(5, {}, { repoRoot: h.repoRoot, ghRepo: h.ghRepo });

      expect(stub).not.toHaveBeenCalled();
      expect(phases.planPhase).toHaveBeenCalled();
    });

    it('serves the run from the offline GitHub stub when FACTORY_GITHUB=stub (#2652)', async () => {
      const stubDir = mkdtempSync(join(tmpdir(), 'factory-gh-stub-'));
      try {
        writeFileSync(
          join(stubDir, 'fixture.json'),
          JSON.stringify({ issues: { '5': { title: 'Stubbed title', body: 'b' } } }),
        );
        vi.stubEnv('FACTORY_GITHUB', 'stub');
        vi.stubEnv('FACTORY_GITHUB_STUB_DIR', stubDir);
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        await shipIssue(5, {}, { repoRoot: h.repoRoot, ghRepo: h.ghRepo }, { octokit: undefined });

        const plan = phases.planPhase.mock.calls.at(-1)?.[0] as any;
        expect(plan.branch).toBe('factory/5-stubbed-title'); // slug of the fixture title
        const captured = phases.shipPhase.mock.calls.at(-1)?.[0] as any;
        await captured.octokit.rest.pulls.create({ head: captured.branch, title: 't', base: 'main' });
        // The wrapper delegates to the real runner; only a harmless non-push command is run here.
        await expect(captured.run('echo stub')).resolves.toMatchObject({ stdout: 'stub\n' });
        const ops = readFileSync(join(stubDir, 'calls.jsonl'), 'utf-8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l).op);
        expect(ops).toContain('pulls.create');
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
        rmSync(stubDir, { recursive: true, force: true });
      }
    });

    it('red base from the pre-PLAN health check throws LaneEnvironmentPauseError before planPhase', async () => {
      const baseSha = 'a'.repeat(40);
      const red = vi.fn<NonNullable<CliDeps['checkBaseHealth']>>(async () => ({
        kind: 'red' as const,
        baseSha,
        failingChecks: ['tests'],
        cached: false,
      }));

      const err = await shipIssue(5, {}, { repoRoot: h.repoRoot, ghRepo: h.ghRepo }, { checkBaseHealth: red }).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(LaneEnvironmentPauseError);
      expect((err as LaneEnvironmentPauseError).baseSha).toBe(baseSha);
      expect((err as LaneEnvironmentPauseError).failingChecks).toEqual(['tests']);
      expect(phases.planPhase).not.toHaveBeenCalled();
    });

    it('a .factory/config template token parks the run before planPhase with file:line', async () => {
      mkdirSync(dirname(paths().config), { recursive: true });
      writeFileSync(paths().config, '{\n  "version": 2,\n  "models": { "pins": { "build": "<owner-name>" } }\n}\n');

      const err = await shipIssue(5, {}, { repoRoot: h.repoRoot, ghRepo: h.ghRepo }).catch((e: unknown) => e);

      expect((err as Error).message).toContain(
        `${relative(h.repoRoot, paths().config)}:3: unfilled template token '<owner-name>'`,
      );
      expect(phases.planPhase).not.toHaveBeenCalled();
    });

    it('routes constitution --product through an injected getConstitutionsDir', async () => {
      writeFileSync(join(h.constitutionsDir, 'alpha.md'), '# alpha');
      const stub = vi.fn(() => h.constitutionsDir);
      await runMainWith(
        { daemon: daemonDeps(), runTui: recordingRunTui, getConstitutionsDir: stub },
        'constitution',
        '--product',
        'alpha',
      );
      expect(stub).toHaveBeenCalled();
      expect(inertConfigLoaders.getConstitutionsDir).not.toHaveBeenCalled();
    });

    it('lists models, costs, and tiers', async () => {
      await runMain('models');
      const out = logged();
      expect(out).toContain('Available Models');
      expect(out).toContain('claude-model');
      expect(out).toContain('Tiers');
      expect(out).toContain('boss:');
    });

    describe('with the real registry and diagnoseModels (#2402)', () => {
      const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
      const saved = { base: process.env.OLLAMA_BASE_URL, localOnly: process.env.FACTORY_LOCAL_ONLY };
      let captured: InstanceType<typeof FactoryCore.ModelRegistry> | undefined;

      beforeEach(() => {
        delete process.env.OLLAMA_BASE_URL;
        delete process.env.FACTORY_LOCAL_ONLY;
        captured = undefined;
        h.execSyncImpl = () => {
          throw new Error('ollama: command not found');
        };
      });

      afterEach(() => {
        if (saved.base === undefined) delete process.env.OLLAMA_BASE_URL;
        else process.env.OLLAMA_BASE_URL = saved.base;
        if (saved.localOnly === undefined) delete process.env.FACTORY_LOCAL_ONLY;
        else process.env.FACTORY_LOCAL_ONLY = saved.localOnly;
      });

      function realDeps(): CliDeps {
        return {
          daemon: daemonDeps(),
          runTui: recordingRunTui,
          ModelRegistry: vi.fn(function (cfg: never) {
            captured = new FactoryCore.ModelRegistry(cfg);
            return captured;
          }) as never,
          diagnoseModels: FactoryCore.diagnoseModels,
        };
      }

      function iconsByModel(out: string, suffix: string): Map<string, string> {
        const map = new Map<string, string>();
        for (const line of out.replace(ANSI, '').split('\n')) {
          const match = line.match(new RegExp(`^\\s*(✅|⚠️|❌) (\\S+) ${suffix}`));
          if (match) map.set(match[2], match[1]);
        }
        return map;
      }

      it('marks every ollama-provider model ❌ when ollama is not on PATH', async () => {
        coreFakes.isCommandAvailable.mockImplementation((c: string) => c !== 'ollama');

        await runMainRaw(realDeps(), 'models');

        const ollamaModels = captured!.list().filter((m) => captured!.get(m)?.provider === 'ollama');
        expect(ollamaModels.length).toBeGreaterThan(0);
        const lines = logged().replace(ANSI, '').split('\n');
        for (const m of ollamaModels) {
          expect(lines.some((l) => l.includes(`❌ ${m} tier=`))).toBe(true);
          expect(lines.some((l) => l.includes(`✅ ${m} tier=`))).toBe(false);
        }
      });

      it('plain list and --doctor show the same status per model', async () => {
        coreFakes.isCommandAvailable.mockImplementation((c: string) => c === 'claude');

        await runMainRaw(realDeps(), 'models');
        const plain = iconsByModel(logged(), 'tier=');
        logSpy.mockClear();
        await runMainRaw(realDeps(), 'models', '--doctor');
        const doctor = iconsByModel(logged(), 'provider=');
        process.exitCode = undefined;

        expect(plain.size).toBeGreaterThan(0);
        expect([...plain.keys()].sort()).toEqual([...doctor.keys()].sort());
        for (const [model, icon] of plain) expect(doctor.get(model)).toBe(icon);
      });

      describe('repo-defined models (#2443)', () => {
        const writeRepoModel = () => {
          mkdirSync(paths().root, { recursive: true });
          writeFileSync(
            paths().config,
            JSON.stringify({
              version: 2,
              models: {
                registry: {
                  'my-opencode-model': {
                    provider: 'custom',
                    tier: 'worker',
                    costPerMtokInput: 1,
                    costPerMtokOutput: 2,
                    contextWindow: 1000,
                    capabilities: [],
                    envKey: null,
                    providerModel: 'my-opencode-model',
                    harness: 'opencode',
                  },
                },
              },
            }),
          );
        };

        afterEach(() => {
          rmSync(paths().config, { force: true });
        });

        it('marks a models.registry model as repo-defined in factory models', async () => {
          writeRepoModel();
          await runMainRaw(realDeps(), 'models');
          const lines = logged().replace(ANSI, '').split('\n');
          expect(lines.find((l) => l.includes('my-opencode-model tier='))).toContain('[repo-defined]');
          for (const m of captured!.list().filter((id) => id !== 'my-opencode-model')) {
            const row = lines.find((l) => l.includes(` ${m} tier=`));
            expect(row).toBeDefined();
            expect(row).not.toContain('[repo-defined]');
          }
        });

        it('marks a models.registry model as repo-defined in factory models --doctor', async () => {
          writeRepoModel();
          await runMainRaw(realDeps(), 'models', '--doctor');
          process.exitCode = undefined;
          const lines = logged().replace(ANSI, '').split('\n');
          expect(lines.find((l) => l.includes('my-opencode-model provider='))).toContain('[repo-defined]');
          expect(lines.filter((l) => l.includes('[repo-defined]'))).toHaveLength(1);
        });
      });
    });

    it('doctor prints the report and returns when a worker is reachable', async () => {
      h.diagnoses = [
        { model: 'w', provider: 'openai', tiers: ['worker'], reachable: true, experimental: false, reason: 'ok' },
      ];
      const res = await runMain('models', '--doctor');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('Model Doctor');
    });

    it('doctor exits 1 when no worker is reachable', async () => {
      h.diagnoses = [
        { model: 'b', provider: 'anthropic', tiers: ['boss'], reachable: true, experimental: false, reason: 'ok' },
      ];
      const res = await runMain('models', '--doctor');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('no worker model is reachable');
    });
  });

  describe('cost', () => {
    it('reports no data when there are no costs', async () => {
      h.costs = [];
      await runMain('cost');
      expect(logged()).toContain('no cost data yet');
    });

    it('--json prints one JSON line with unpriced rows as null', async () => {
      h.costs = [
        { ts: 't', issue: '296', task: 'plan', model: 'a', inputTokens: 1, outputTokens: 2, cost: 1 },
        { ts: 't', issue: '297', task: 'build', model: 'b', cost: null, unpriced: true },
      ];
      const res = await runMain('cost', '--json');
      expect(res.exited).toBe(false);
      const out = logged().trim();
      expect(out.split('\n')).toHaveLength(1);
      const json = JSON.parse(out);
      expect(json.schemaVersion).toBe(1);
      expect(json.total).toEqual({ cost: 1, unpricedCount: 1 });
      expect(json.rows[1].cost).toBeNull();
    });

    it('--json --issue keeps only that issue', async () => {
      h.costs = [
        { issue: '296', task: 'plan', model: 'a', cost: 1 },
        { issue: '297', task: 'plan', model: 'b', cost: 2 },
      ];
      await runMain('cost', '--json', '--issue', '296');
      const json = JSON.parse(logged());
      expect(json.rows).toHaveLength(1);
      expect(json.rows[0].issue).toBe('296');
      expect(json.total).toEqual({ cost: 1, unpricedCount: 0 });
    });

    it('--json with no costs prints empty JSON, not the text message', async () => {
      h.costs = [];
      await runMain('cost', '--json');
      expect(JSON.parse(logged())).toEqual({
        schemaVersion: 1,
        rows: [],
        perModel: [],
        total: { cost: 0, unpricedCount: 0 },
      });
    });

    it('--json exits 1 when reading costs throws', async () => {
      const res = await runMainWith(
        {
          readCosts: () => {
            throw new Error('boom');
          },
        },
        'cost',
        '--json',
      );
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('factory: cost failed');
      expect(logged()).toBe('');
    });

    it('uses a readCosts override passed through main deps', async () => {
      h.costs = [{ model: 'shared', cost: 1 }];
      await runMainWith(
        { readCosts: () => [{ issue: '9', task: 'plan', model: 'override-model', cost: 1 }] as any },
        'cost',
      );
      const out = logged();
      expect(out).toContain('override-model');
      expect(out).not.toContain('shared');
    });

    it('uses a formatUsageReport override passed through main deps', async () => {
      await runMainWith({ formatUsageReport: () => 'OVERRIDE USAGE' } as any, 'usage');
      expect(logged()).toContain('OVERRIDE USAGE');
    });

    it('aggregates costs by model with a grand total', async () => {
      h.costs = [
        { model: 'a', cost: 1 },
        { model: 'a', cost: 0.5 },
        { model: 'b', cost: 2 },
      ];
      await runMain('cost');
      const out = logged();
      expect(out).toContain('Cost Summary');
      expect(out).toContain('a: 2 tasks, $1.5000');
      expect(out).toContain('b: 1 tasks, $2.0000');
      expect(out).toContain('Total: $3.5000');
    });

    it('prints unknown for an all-unpriced summary', async () => {
      h.costs = [{ model: 'x', cost: null, unpriced: true }];
      await runMain('cost');
      const out = logged();
      expect(out).toContain('Total: unknown (1 unpriced)');
      expect(out).not.toContain('$0.0000');
    });

    it('excludes unpriced rows from a mixed total and counts them', async () => {
      h.costs = [
        { model: 'a', cost: 1 },
        { model: 'x', cost: null, unpriced: true },
      ];
      await runMain('cost');
      expect(logged()).toContain('Total: $1.0000 (1 unpriced)');
    });

    it('prints unknown for an unpriced row under --issue', async () => {
      h.costs = [{ issue: '5', task: 'plan', model: 'x', cost: null, unpriced: true }];
      await runMain('cost', '--issue', '5');
      const out = logged();
      expect(out).toContain('plan x unknown');
      expect(out).toContain('Total: unknown (1 unpriced)');
    });

    it('shows a per-entry breakdown filtered to one issue via --issue', async () => {
      h.costs = [
        { issue: '296', task: 'build_codex', model: 'qwen', cost: 0, failoverReason: 'rate_limit' },
        { issue: '296', task: 'plan', model: 'opus', cost: 0.12 },
        { issue: '7', task: 'plan', model: 'opus', cost: 0.05 },
      ];
      await runMain('cost', '--issue', '296');
      const out = logged();
      expect(out).toContain('build_codex');
      expect(out).toContain('qwen');
      expect(out).toContain('[failover: rate_limit]');
      expect(out).not.toContain('0.05');
    });

    it('reports no cost data for an issue with no entries', async () => {
      h.costs = [{ issue: '7', task: 'plan', model: 'opus', cost: 0.05 }];
      await runMain('cost', '--issue', '296');
      expect(logged()).toContain('no cost data for issue 296');
    });

    it('appends a failover count to the summary line only when failovers are present', async () => {
      h.costs = [
        { model: 'a', cost: 1 },
        { model: 'a', cost: 0.5, failoverReason: 'rate_limit' },
        { model: 'b', cost: 2 },
      ];
      await runMain('cost');
      const out = logged();
      expect(out).toContain('a: 2 tasks, $1.5000 (1 failover)');
      expect(out).toContain('b: 1 tasks, $2.0000');
      expect(out).not.toContain('b: 1 tasks, $2.0000 (');
    });
  });

  describe('usage', () => {
    it('prints the usage report from resolved knobs', async () => {
      await runMain('usage');
      expect(logged()).toContain('USAGE REPORT');
    });

    it('exits 2 on an invalid usage cap', async () => {
      process.env.FACTORY_USAGE_CAP = '-5';
      const res = await runMain('usage');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('FACTORY_USAGE_CAP');
    });

    it('--json prints the subscription reading as one JSON object', async () => {
      h.subscriptionUsage = { fiveHourUtilization: 42, fiveHourResetsAt: '2026-07-15T18:00:00Z' };
      const res = await runMain('usage', '--json');
      expect(res).toEqual({ exited: false, code: undefined });
      expect(JSON.parse(logged())).toMatchObject({
        schemaVersion: 1,
        source: 'subscription',
        utilizationPct: 42,
        resetsAt: '2026-07-15T18:00:00Z',
      });
      expect(logged()).not.toContain('USAGE REPORT');
    });

    it('--json falls back to the heuristic when no subscription reading', async () => {
      h.subscriptionUsage = null;
      await runMain('usage', '--json');
      const json = JSON.parse(logged());
      expect(json.source).toBe('heuristic');
      expect(json.estimateUsd).toBe(h.trailingSpend);
    });

    it('--json is unavailable with nulls when the estimator throws', async () => {
      h.subscriptionUsage = null;
      const res = await runMainWith(
        {
          estimateTrailingSpend: () => {
            throw new Error('boom');
          },
        } as any,
        'usage',
        '--json',
      );
      expect(res).toEqual({ exited: false, code: undefined });
      expect(JSON.parse(logged())).toMatchObject({
        source: 'unavailable',
        utilizationPct: null,
        resetsAt: null,
        estimateUsd: null,
      });
    });

    it('--json exits 2 on an invalid usage cap with nothing on stdout', async () => {
      process.env.FACTORY_USAGE_CAP = '-5';
      const res = await runMain('usage', '--json');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('FACTORY_USAGE_CAP');
      expect(logged()).toBe('');
    });
  });

  describe('check / ready', () => {
    const COMPLETE_BODY = `### Problem statement

Something is wrong.

### In scope

Fix it.

### Out of scope

Nothing else.

### Acceptance criteria

- [ ] it works

### Verification

bash scripts/verify.sh
`;

    it('prints the ready line and exits 0 for a complete issue body', async () => {
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix it', body: COMPLETE_BODY } }));
      const res = await runMain('ready', '421');
      expect(res).toEqual({ exited: false, code: undefined });
      expect(logged()).toContain('issue #421 is factory-ready (factory-task, score 100%)');
    });

    it('prints the missing fields and exits 1 for an incomplete issue body', async () => {
      const incompleteBody = COMPLETE_BODY.replace(/### Verification\n\nbash scripts\/verify\.sh\n/, '');
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix it', body: incompleteBody } }));
      const res = await runMain('ready', '421');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged()).toContain('missing: Verification');
      expect(errored()).toContain('issue #421 is not factory-ready — missing: Verification');
    });

    const bigBody = COMPLETE_BODY.replace(
      '- [ ] it works',
      Array.from({ length: 7 }, (_, i) => `- [ ] c${i}`).join('\n'),
    );

    it('check prints the runs-as-is size line and exits 0', async () => {
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix it', body: COMPLETE_BODY } }));
      const res = await runMain('check', '421');
      expect(res).toEqual({ exited: false, code: undefined });
      expect(logged()).toContain('size: runs as-is');
    });

    it('exits 3 and says would split for an oversized issue', async () => {
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix it', body: bigBody } }));
      const res = await runMain('check', '421');
      expect(res).toEqual({ exited: true, code: 3 });
      expect(logged()).toContain('would split');
    });

    it('ready is an alias with identical output', async () => {
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix it', body: COMPLETE_BODY } }));
      await runMain('check', '421');
      const viaCheck = logged();
      logSpy.mockClear();
      await runMain('ready', '421');
      expect(logged()).toBe(viaCheck);
    });

    it('--json prints one parseable object', async () => {
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix it', body: COMPLETE_BODY } }));
      await runMain('check', '421', '--json');
      expect(JSON.parse(logged())).toMatchObject({ issue: 421, exitCode: 0 });
    });

    it('exits 2 on an invalid issue argument', async () => {
      const res = await runMain('ready', 'abc');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(h.octokit.rest.issues.get).not.toHaveBeenCalled();
    });
  });

  describe('logs', () => {
    it('prints existing events for the non-follow path', async () => {
      writeFileSync(
        paths().events,
        [JSON.stringify({ ts: '', type: 'plan', issue: '1', msg: 'Starting plan phase' })].join('\n'),
      );
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        const res = await runMain('logs');
        expect(res.exited).toBe(false);
        const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(written).toContain('[factory] plan #1: Starting plan phase');
      } finally {
        writeSpy.mockRestore();
      }
    });

    it('filters by --issue', async () => {
      writeFileSync(
        paths().events,
        [
          JSON.stringify({ ts: '', type: 'plan', issue: '296', msg: 'a' }),
          JSON.stringify({ ts: '', type: 'plan', issue: '301', msg: 'b' }),
        ].join('\n'),
      );
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await runMain('logs', '--issue', '296');
        const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(written).toContain('#296');
        expect(written).not.toContain('#301');
      } finally {
        writeSpy.mockRestore();
      }
    });
  });

  describe('filing preview (#1858)', () => {
    it('resolves the factory commit through the injected exec seam, not node:child_process (#2014)', async () => {
      // h.repoRoot doubles as the factory checkout: the shell fake answers every
      // `git rev-parse --show-toplevel` with it, so resolveFactoryCheckoutCommit
      // finds the CLI package.json there and then asks the seam for HEAD.
      mkdirSync(join(h.repoRoot, 'packages', 'cli'), { recursive: true });
      writeFileSync(
        join(h.repoRoot, 'packages', 'cli', 'package.json'),
        JSON.stringify({ name: '@on-par/factory-cli' }),
      );
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse --show-toplevel')) return h.repoRoot;
        if (cmd.includes('rev-parse HEAD')) return 'c0ffee2014\n';
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };
      writeFileSync(
        paths().events,
        JSON.stringify({
          ts: '2026-01-01T00:00:00Z',
          type: 'park',
          issue: '77',
          fingerprint: 'fp-2014-shell-seam',
          evidence: {
            issue: '77',
            phase: 'build',
            model: 'claude-sonnet',
            reason: 'unknown',
            component: 'claude',
            origin: 'factory-internal',
            eventExcerpt: 'Error: boom',
            logPath: '/tmp/x.log',
          },
        }) + '\n',
      );
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const res = await runMain('filing', 'preview', 'fp-2014-shell-seam');
        expect(res.exited).toBe(false);
        const written = out.mock.calls.map((c) => String(c[0])).join('');
        expect(written).toContain('fp:fp-2014-shell-seam');
        expect(written).toContain('c0ffee2014');
        expect(ops.exec).toHaveBeenCalledWith(
          'git rev-parse HEAD',
          expect.objectContaining({ cwd: expect.any(String) }),
        );
        expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('Preview only — nothing was sent.');
      } finally {
        out.mockRestore();
        err.mockRestore();
      }
    });
  });

  describe('classifier report (#1727)', () => {
    const outRec = (prNumber: number, o: Record<string, unknown> = {}) => ({
      issue: String(prNumber),
      prNumber,
      classifiedAt: '2026-09-01T00:00:00.000Z',
      modelClass: 'A',
      floorClass: 'A',
      finalClass: 'A',
      model: 'm',
      promptVersion: 'p1',
      policyVersion: 'v1',
      diffSha: null,
      humanApproved: false,
      humanEdited: false,
      humanAbandoned: false,
      merged: true,
      mergedAt: '2026-08-01T00:00:00.000Z',
      defectWindowClosed: true,
      defectFired: false,
      verdict: 'agree',
      slipped: false,
      ...o,
    });
    const seed = () => {
      const recs = [
        ...Array.from({ length: 60 }, (_, i) => outRec(i + 1)),
        outRec(100, { modelClass: 'B', merged: false, defectWindowClosed: false, verdict: 'pending' }),
      ];
      writeFileSync(paths().classifierOutcomes, `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`);
    };

    it('prints the table, bounds and unknown', async () => {
      seed();
      await runMain('classifier', 'report');
      const out = logged();
      expect(out).toContain('human-gated');
      expect(out).toContain('A: 60 closed, 0 slipped — slip rate ≤ 5%');
      expect(out).toContain('C: 0 closed, 0 slipped — slip rate unknown');
    });

    it('--json prints one JSON object', async () => {
      seed();
      await runMain('classifier', 'report', '--json');
      const lines = logged().trim().split('\n');
      expect(lines).toHaveLength(1);
      const report = JSON.parse(lines[0]);
      expect(report.classes.A.upperBound).toBeCloseTo(0.05);
      expect(report.classes.C.upperBound).toBeNull();
    });

    it('a missing file is not an error', async () => {
      const res = await runMain('classifier', 'report');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('factory kpis');
      expect(logged()).toContain('unknown');
    });
  });

  describe('classifier backtest (#1728)', () => {
    async function captureOutput(...args: string[]) {
      const outWrite = process.stdout.write.bind(process.stdout);
      const errWrite = process.stderr.write.bind(process.stderr);
      const written: string[] = [];
      const sink = ((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      process.stdout.write = sink;
      process.stderr.write = sink;
      try {
        const res = await runMain(...args);
        return { res, text: `${written.join('')}\n${errored()}`.replace(/\s+/g, ' ') };
      } finally {
        process.stdout.write = outWrite;
        process.stderr.write = errWrite;
      }
    }

    it('requires --since', async () => {
      const { res, text } = await captureOutput('classifier', 'backtest');
      expect(res.exited).toBe(true);
      expect(text).toContain("required option '--since <date>' not specified");
    });

    it('is listed under classifier --help', async () => {
      const { text } = await captureOutput('classifier', '--help');
      expect(text).toContain('backtest');
    });

    it('exits 2 on an invalid --since', async () => {
      const res = await runMain('classifier', 'backtest', '--since', 'yesterday');
      expect(res.exited).toBe(true);
      expect(res.code).toBe(2);
      expect(errored()).toContain("invalid --since 'yesterday'");
    });

    it('replays a merged PR through the wired deps and writes the JSONL file', async () => {
      const mergedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      h.octokit.rest.pulls.list = vi.fn(async ({ state }: any) =>
        state === 'all'
          ? {
              data: [
                {
                  number: 77,
                  head: { ref: 'factory/1-fix-the-bug' },
                  state: 'closed',
                  merged_at: mergedAt,
                  merge_commit_sha: 'abcdef1234567',
                  closed_at: null,
                },
              ],
            }
          : { data: [] },
      );
      h.octokit.rest.pulls.listCommits = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.pulls.listReviews = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.pulls.get = vi.fn(async () => ({ data: { merged_by: { login: 'patrob' } } }));
      h.octokit.rest.repos = { listCommits: vi.fn(async () => ({ data: [] })) };
      const execImpl = h.execImpl;
      h.execImpl = (cmd: string) => {
        if (cmd.startsWith('git diff --numstat')) return '1\t0\tdocs/a.md\n';
        if (cmd.startsWith('git diff')) return 'diff --git a/docs/a.md b/docs/a.md\n+hello\n';
        return execImpl(cmd);
      };
      writeFileSync(paths().events, `${JSON.stringify({ type: 'issue-title', issue: '1', msg: 'title' })}\n`);
      const labels = join(h.repoRoot, 'labels.csv');
      writeFileSync(labels, 'pr,class\n77,clean\n');

      const res = await runMain('classifier', 'backtest', '--since', '2026-01-01', '--labels', labels);

      expect(res.exited).toBe(false);
      expect(logged()).toContain('covered 1 of 1 PRs');
      const files = readdirSync(paths().state).filter((f) => f.startsWith('classifier-backtest-'));
      expect(files).toHaveLength(1);
      const record = JSON.parse(readFileSync(join(paths().state, files[0]), 'utf-8').trim());
      expect(record).toMatchObject({ prNumber: 77, labelSource: 'hand', outcomeLabel: 'clean' });
      expect(logged()).toContain(`Wrote ${join(paths().state, files[0])}`);
    });
  });

  describe('garden --report (#2083)', () => {
    const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();
    const parkLine = (issue: string, ts: string) =>
      JSON.stringify({
        ts,
        type: 'fail',
        issue,
        msg: 'parked',
        checkFailure: { signature: 'tests|boom', failingChecks: ['tests'] },
      });

    it('prints one cluster with count and path:line pointers, deterministically', async () => {
      writeFileSync(
        paths().events,
        `${[parkLine('1', hoursAgo(3)), parkLine('2', hoursAgo(2)), parkLine('1', hoursAgo(1))].join('\n')}\n`,
      );
      await runMain('garden', '--report');
      const first = logged();
      expect(first).toContain('## CHECK failure signatures');
      expect(first).toContain('## Park reasons');
      expect(first).toContain('## Failing checkers');
      expect(first).toContain('### 1. `fail`');
      expect(first).toContain('### 1. `tests`');
      expect(first).not.toContain('### 2.');
      expect(first).toContain('count: 3');
      for (const n of [1, 2, 3]) expect(first).toContain(`${paths().events}:${n}`);
      logSpy.mockClear();
      await runMain('garden', '--report');
      expect(logged()).toEqual(first);
    });

    it('excludes events of an environment-released run', async () => {
      const line = (type: string, issue: string) => JSON.stringify({ ts: hoursAgo(5), type, issue, msg: 'm' });
      writeFileSync(
        paths().events,
        `${[line('human-edited', '9'), line('environment-released', '9'), parkLine('1', hoursAgo(4))].join('\n')}\n`,
      );
      await runMain('garden', '--report');
      expect(logged()).not.toContain('human-edited');
      expect(logged()).not.toContain('## Human events');
    });

    it('prints no clusters for a missing events file and does not exit', async () => {
      const res = await runMain('garden', '--report');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('no clusters');
    });

    const sigLine = (issue: string, sig: string, ts: string) =>
      JSON.stringify({
        ts,
        type: 'fail',
        issue,
        msg: 'parked',
        checkFailure: { signature: sig, failingChecks: ['tests'] },
      });

    it('--since and --max-clusters scope the report', async () => {
      writeFileSync(
        paths().events,
        `${[
          sigLine('1', 'sig-a', hoursAgo(24)),
          sigLine('2', 'sig-b', hoursAgo(25)),
          sigLine('3', 'sig-c', hoursAgo(26)),
          sigLine('4', 'sig-old', hoursAgo(24 * 30)),
        ].join('\n')}\n`,
      );
      await runMain('garden', '--report', '--since', '7d', '--max-clusters', '2');
      expect(logged()).not.toContain('sig-old');
      expect((logged().match(/^### /gm) ?? []).length).toBeLessThanOrEqual(2);
    });

    it('--json prints the cluster data as JSON', async () => {
      writeFileSync(paths().events, `${parkLine('1', hoursAgo(1))}\n`);
      await runMain('garden', '--report', '--json');
      const doc = JSON.parse(logged());
      expect(doc.since).toBe('14d');
      expect(doc.maxClusters).toBe(10);
      expect(doc.clusters[0]).toMatchObject({ dimension: expect.any(String), key: expect.any(String), count: 1 });
      for (const k of ['issues', 'samples', 'failingChecks', 'firstSeen', 'lastSeen'])
        expect(doc.clusters[0]).toHaveProperty(k);
    });

    it('--out writes the report to a file and nothing to stdout', async () => {
      writeFileSync(paths().events, `${parkLine('1', hoursAgo(1))}\n`);
      const out = join(h.repoRoot, 'report.md');
      await runMain('garden', '--report', '--out', out);
      expect(readFileSync(out, 'utf8')).toContain('# Garden report');
      expect(logSpy).not.toHaveBeenCalled();
      expect(errored()).toContain(`wrote report to ${out}`);
    });

    it('--out with --json writes valid JSON', async () => {
      writeFileSync(paths().events, `${parkLine('1', hoursAgo(1))}\n`);
      const out = join(h.repoRoot, 'report.json');
      await runMain('garden', '--report', '--json', '--out', out);
      expect(JSON.parse(readFileSync(out, 'utf8')).clusters.length).toBeGreaterThan(0);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('rejects an invalid --since or --max-clusters', async () => {
      const a = await runMain('garden', '--report', '--since', 'bogus');
      expect(a.exited).toBe(true);
      expect(a.code).not.toBe(0);
      const b = await runMain('garden', '--report', '--max-clusters', '0');
      expect(b.exited).toBe(true);
      expect(b.code).not.toBe(0);
    });

    it('exits non-zero when --out cannot be written', async () => {
      const out = join(h.repoRoot, 'missing-dir', 'r.md');
      const res = await runMain('garden', '--report', '--out', out);
      expect(res.exited).toBe(true);
      expect(errored()).toContain(`factory garden: cannot write ${out}`);
    });

    describe('read-only and empty input (#2088)', () => {
      afterEach(() => {
        vi.unstubAllGlobals();
      });

      const emptyDoc = { since: '14d', maxClusters: 10, clusters: [] };

      const guardSideEffects = (opts: { searchAllowed: boolean }) => {
        const octokitFactory = vi.fn(() => h.octokit);
        ops.octokit = octokitFactory;
        const fetchFn = vi.fn(async () => {
          throw new Error('network');
        });
        vi.stubGlobal('fetch', fetchFn);
        return () => {
          expect(fetchFn).not.toHaveBeenCalled();
          const cmds = [...ops.exec.mock.calls, ...ops.execSync.mock.calls].map((c) => String(c[0]));
          const ghCmds = cmds.filter((c) => /(^|\s)gh\s/.test(c));
          if (opts.searchAllowed) {
            expect(h.octokit.rest.search.issuesAndPullRequests).toHaveBeenCalled();
            for (const c of ghCmds) expect(c).toMatch(/gh (repo view|auth token)/);
          } else {
            expect(octokitFactory).not.toHaveBeenCalled();
            expect(ghCmds).toEqual([]);
          }
          for (const fn of Object.values(h.octokit.rest.issues)) expect(fn).not.toHaveBeenCalled();
        };
      };

      it('only reads: searches GitHub but creates no issue, label or comment', async () => {
        writeFileSync(paths().events, `${[parkLine('1', hoursAgo(2)), parkLine('2', hoursAgo(1))].join('\n')}\n`);
        const argvs = [
          ['garden', '--report'],
          ['garden', '--report', '--json'],
          ['garden', '--report', '--out', join(h.repoRoot, 'r.md')],
        ];
        for (const argv of argvs) {
          const check = guardSideEffects({ searchAllowed: true });
          const res = await runMain(...argv);
          expect(res.exited).toBe(false);
          check();
        }
      });

      it('empty input makes no network call, creates no octokit and runs no gh', async () => {
        writeFileSync(paths().events, '');
        const check = guardSideEffects({ searchAllowed: false });
        const res = await runMain('garden', '--report');
        expect(res.exited).toBe(false);
        check();
      });

      it('an empty events file prints no clusters and exits 0', async () => {
        writeFileSync(paths().events, '');
        const res = await runMain('garden', '--report');
        expect(res.exited).toBe(false);
        expect(res.code).toBeUndefined();
        expect(logged()).toContain('no clusters');
      });

      it('only out-of-window events print no clusters and exit 0', async () => {
        writeFileSync(paths().events, `${parkLine('1', hoursAgo(24 * 30))}\n`);
        const res = await runMain('garden', '--report');
        expect(res.exited).toBe(false);
        expect(logged()).toContain('no clusters');
      });

      it('--json with empty input prints an empty clusters document and exits 0', async () => {
        const res = await runMain('garden', '--report', '--json');
        expect(res.exited).toBe(false);
        expect(JSON.parse(logged())).toEqual(emptyDoc);
      });

      it('--out with empty input writes no clusters and exits 0', async () => {
        const out = join(h.repoRoot, 'empty.md');
        const res = await runMain('garden', '--report', '--out', out);
        expect(res.exited).toBe(false);
        expect(readFileSync(out, 'utf8')).toBe('no clusters\n');
        expect(logSpy).not.toHaveBeenCalled();
        expect(errored()).toContain('wrote report to');
      });

      it('--json --out with empty input writes the empty JSON document', async () => {
        const out = join(h.repoRoot, 'empty.json');
        const res = await runMain('garden', '--report', '--json', '--out', out);
        expect(res.exited).toBe(false);
        expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(emptyDoc);
      });
    });

    describe('tracked/new annotation (#2102)', () => {
      const writeEvents = () => writeFileSync(paths().events, `${parkLine('1', hoursAgo(2))}\n`);

      it('annotates a cluster as tracked when an open issue carries a garden marker', async () => {
        writeEvents();
        h.octokit.rest.search.issuesAndPullRequests.mockImplementation((async () => ({
          data: { items: [{ number: 31, state: 'open', body: '<!-- garden:tests|boom -->' }] },
        })) as any);
        await runMain('garden', '--report');
        expect(logged()).toContain('- tracked: #31');
      });

      it('annotates a cluster as new when nothing matches', async () => {
        writeEvents();
        await runMain('garden', '--report');
        expect(logged()).toContain('- new');
      });

      it('--json clusters carry tracking', async () => {
        writeEvents();
        await runMain('garden', '--report', '--json');
        const doc = JSON.parse(logged());
        expect(doc.clusters.length).toBeGreaterThan(0);
        for (const c of doc.clusters) expect(c.tracking).toEqual({ status: 'new' });
      });

      it('renders tracked: unknown and exits 0 when the search fails', async () => {
        writeEvents();
        h.octokit.rest.search.issuesAndPullRequests.mockRejectedValue(new Error('rate limited'));
        const res = await runMain('garden', '--report');
        expect(res.exited).toBe(false);
        expect(logged()).toContain('### 1.');
        expect(logged()).toContain('- tracked: unknown');
        expect(logged()).not.toContain('- new');
        expect(errored()).toContain('issue search unavailable');
      });

      it('--json marks every cluster unknown when the search fails', async () => {
        writeEvents();
        h.octokit.rest.search.issuesAndPullRequests.mockRejectedValue(new Error('rate limited'));
        const res = await runMain('garden', '--report', '--json');
        expect(res.exited).toBe(false);
        const doc = JSON.parse(logged());
        expect(doc.clusters.length).toBeGreaterThan(0);
        for (const c of doc.clusters) expect(c.tracking).toEqual({ status: 'unknown' });
      });

      it('marks every cluster unknown and exits 0 when the repo cannot be resolved (no network)', async () => {
        writeEvents();
        const execImpl = h.execImpl;
        h.execImpl = (cmd: string) => {
          if (cmd.startsWith('gh repo view'))
            throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
          return execImpl(cmd);
        };
        const res = await runMain('garden', '--report');
        expect(res.exited).toBe(false);
        expect(logged()).toContain('### 1.');
        expect(logged()).toContain('- tracked: unknown');
        expect(errored()).toContain('issue search unavailable');
      });
    });

    describe('--only-new (#2104)', () => {
      const writeEvents = () => writeFileSync(paths().events, `${parkLine('1', hoursAgo(2))}\n`);
      const mockTracked = () =>
        h.octokit.rest.search.issuesAndPullRequests.mockImplementation((async () => ({
          data: {
            items: [
              {
                number: 31,
                state: 'open',
                body: '<!-- garden:fail --> <!-- garden:tests --> <!-- garden:tests|boom -->',
              },
            ],
          },
        })) as any);

      it('omits clusters tracked by an open issue', async () => {
        writeEvents();
        mockTracked();
        const res = await runMain('garden', '--report', '--only-new');
        expect(res.exited).toBe(false);
        expect(logged()).not.toContain('- tracked: #31');
        expect(logged()).not.toContain('### 1.');
        expect(logged()).toContain('no clusters');
      });

      it('keeps new clusters', async () => {
        writeEvents();
        await runMain('garden', '--report', '--only-new');
        expect(logged()).toContain('- new');
        expect(logged()).toContain('### 1.');
      });

      it('--json --only-new yields no clusters when all are tracked', async () => {
        writeEvents();
        mockTracked();
        await runMain('garden', '--report', '--json', '--only-new');
        expect(JSON.parse(logged()).clusters).toEqual([]);
      });

      it('keeps tracked: unknown clusters when the search fails', async () => {
        writeEvents();
        h.octokit.rest.search.issuesAndPullRequests.mockRejectedValue(new Error('rate limited'));
        const res = await runMain('garden', '--report', '--only-new');
        expect(res.exited).toBe(false);
        expect(logged()).toContain('- tracked: unknown');
      });
    });

    it('exits non-zero without --report', async () => {
      const res = await runMain('garden');
      expect(res.exited).toBe(true);
      expect(res.code).not.toBe(0);
    });
  });

  describe('kpis', () => {
    it('renders a report and trend, and records a snapshot on each run', async () => {
      writeFileSync(
        paths().events,
        [
          JSON.stringify({ type: 'issue-title', issue: '1', msg: 'title' }),
          JSON.stringify({ type: 'merged', issue: '1', msg: 'merged' }),
          JSON.stringify({ type: 'issue-title', issue: '2', msg: 'title' }),
          JSON.stringify({ type: 'rework', issue: '2', msg: 'rework' }),
          '',
        ].join('\n'),
      );
      writeFileSync(paths().costs, '');
      h.costs = [{ issue: '1', task: 'build', model: 'a', cost: 0.5 }];
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse HEAD')) return 'deadbeef';
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };

      const bad = await runMain('kpis', '--branch-prefix', '!!!');
      expect(bad).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('--branch-prefix');

      await runMain('kpis');
      const out = logged();
      expect(out).toContain('## Health KPIs');
      expect(out).toContain('## Health KPI trend');
      expect(existsSync(paths().kpiHistory)).toBe(true);
      const historyLines = (jsonl: string) => jsonl.trim().split('\n').filter(Boolean);
      expect(historyLines(readFileSync(paths().kpiHistory, 'utf-8'))).toHaveLength(1);
      const firstRecord = JSON.parse(historyLines(readFileSync(paths().kpiHistory, 'utf-8'))[0]);
      expect(firstRecord.commitSha).toBe('deadbeef');
      expect(firstRecord.models).toEqual({});
      expect(firstRecord).not.toHaveProperty('partial');

      await runMain('kpis');
      expect(historyLines(readFileSync(paths().kpiHistory, 'utf-8'))).toHaveLength(2);
    });

    it('a GitHub failure during reconstruction marks the snapshot partial and warns (#2342)', async () => {
      writeFileSync(paths().events, JSON.stringify({ type: 'issue-title', issue: '1', msg: 'title' }));
      writeFileSync(paths().costs, '');
      h.octokit.rest.pulls.list = vi.fn(async () => {
        throw new Error('rate limited');
      });

      await runMain('kpis');
      expect(errored()).toContain('human-event reconstruction failed');
      expect(errored()).toContain('rate limited');
      expect(errored()).toContain('marked partial');
      const record = JSON.parse(readFileSync(paths().kpiHistory, 'utf-8').trim().split('\n')[0]);
      expect(record.partial).toBe(true);
    });

    it('still renders the report when the KPI snapshot fails (e.g. a malformed repo tier config)', async () => {
      writeFileSync(paths().config, JSON.stringify({ tiers: { worker: ['no-such-model'] } }));
      writeFileSync(paths().events, JSON.stringify({ type: 'issue-title', issue: '1', msg: 'title' }));

      const res = await runMain('kpis');
      expect(res.exited).toBe(false);
      const out = logged();
      expect(out).toContain('## Health KPIs');
      expect(out).toContain('## Health KPI trend');
      expect(errored()).toContain('KPI snapshot failed');
      expect(existsSync(paths().kpiHistory)).toBe(false);
    });

    it('records postMergeDefectRate when a merged PR has a closed window and a matching revert commit (#612)', async () => {
      writeFileSync(paths().events, JSON.stringify({ type: 'issue-title', issue: '1', msg: 'title' }));
      writeFileSync(paths().costs, '');
      const mergedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const revertAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
      h.octokit.rest.pulls.list = vi.fn(async ({ state }: any) =>
        state === 'all'
          ? {
              data: [
                {
                  number: 77,
                  head: { ref: 'ship-it/1-fix-the-bug' },
                  state: 'closed',
                  merged_at: mergedAt,
                  merge_commit_sha: 'abcdef1234567',
                  closed_at: null,
                },
              ],
            }
          : { data: [] },
      );
      h.octokit.rest.pulls.listCommits = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.pulls.listReviews = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.pulls.get = vi.fn(async () => ({ data: { merged_by: { login: 'patrob' } } }));
      h.octokit.rest.repos = {
        listCommits: vi.fn(async () => ({
          data: [{ sha: 'deadbeef1234', commit: { message: 'Revert "fix thing" (#77)', author: { date: revertAt } } }],
        })),
      };
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.issues.listComments = vi.fn(async () => ({ data: [] }));

      await runMain('kpis');
      const out = logged();
      expect(out).toContain('Post-merge defects:');
      const record = JSON.parse(readFileSync(paths().kpiHistory, 'utf-8').trim().split('\n')[0]);
      expect(record.defectWindowClosedRuns).toBe(1);
      expect(record.postMergeDefectRate).toBe(1);
    });

    it('upserts classifier outcomes once per PR across repeated kpis runs (#1726)', async () => {
      const mergedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      writeFileSync(
        paths().events,
        JSON.stringify({
          type: 'pr-classified',
          issue: '1',
          ts: mergedAt,
          prClassification: {
            modelClass: 'A',
            floorClass: 'B',
            finalClass: 'B',
            model: 'm',
            promptVersion: 'p1',
            policyVersion: 'f1',
            diffSha: 'abc',
            adrIds: [],
            costUsd: null,
            claims: [],
            unsupportedClaims: [],
            notInspected: [],
            droppedClaims: 0,
          },
        }),
      );
      writeFileSync(paths().costs, '');
      h.octokit.rest.pulls.list = vi.fn(async ({ state }: any) =>
        state === 'all'
          ? {
              data: [
                {
                  number: 77,
                  head: { ref: 'ship-it/1-fix-the-bug' },
                  state: 'closed',
                  merged_at: mergedAt,
                  merge_commit_sha: 'abcdef1234567',
                  closed_at: null,
                },
              ],
            }
          : { data: [] },
      );
      h.octokit.rest.pulls.listCommits = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.pulls.listReviews = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.pulls.get = vi.fn(async () => ({ data: { merged_by: { login: 'patrob' } } }));
      h.octokit.rest.repos = { listCommits: vi.fn(async () => ({ data: [] })) };
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.issues.listComments = vi.fn(async () => ({ data: [] }));

      await runMain('kpis');
      await runMain('kpis');
      const lines = readFileSync(paths().classifierOutcomes, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ prNumber: 77, modelClass: 'A', verdict: 'agree' });
    });

    it('does not write classifier outcomes when post-merge defect detection fails (#1726)', async () => {
      writeFileSync(paths().events, JSON.stringify({ type: 'issue-title', issue: '1', msg: 'title' }));
      writeFileSync(paths().costs, '');
      h.octokit.rest.pulls.list = vi.fn(async ({ state }: any) =>
        state === 'all'
          ? {
              data: [
                {
                  number: 77,
                  head: { ref: 'ship-it/1-fix-the-bug' },
                  state: 'closed',
                  merged_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
                  merge_commit_sha: 'abcdef1234567',
                  closed_at: null,
                },
              ],
            }
          : { data: [] },
      );
      h.octokit.rest.pulls.listCommits = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.pulls.listReviews = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.pulls.get = vi.fn(async () => ({ data: { merged_by: { login: 'patrob' } } }));
      h.octokit.rest.repos = {
        listCommits: vi.fn(async () => {
          throw new Error('rate limited');
        }),
      };
      await runMain('kpis');
      expect(existsSync(paths().classifierOutcomes)).toBe(false);
    });

    it('omits postMergeDefectRate and warns when the post-merge defect fetch fails (#612)', async () => {
      writeFileSync(paths().events, JSON.stringify({ type: 'issue-title', issue: '1', msg: 'title' }));
      writeFileSync(paths().costs, '');
      const mergedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      h.octokit.rest.pulls.list = vi.fn(async ({ state }: any) =>
        state === 'all'
          ? {
              data: [
                {
                  number: 77,
                  head: { ref: 'ship-it/1-fix-the-bug' },
                  state: 'closed',
                  merged_at: mergedAt,
                  merge_commit_sha: 'abcdef1234567',
                  closed_at: null,
                },
              ],
            }
          : { data: [] },
      );
      h.octokit.rest.pulls.listCommits = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.pulls.listReviews = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.pulls.get = vi.fn(async () => ({ data: { merged_by: { login: 'patrob' } } }));
      h.octokit.rest.repos = {
        listCommits: vi.fn(async () => {
          throw new Error('rate limited');
        }),
      };

      await runMain('kpis');
      const out = logged();
      expect(out).toContain('## Health KPIs');
      expect(errored()).toContain('post-merge defect signals unavailable');
      const record = JSON.parse(readFileSync(paths().kpiHistory, 'utf-8').trim().split('\n')[0]);
      expect(record.postMergeDefectRate).toBeNull();
    });
  });

  describe('tui', () => {
    it('uses an injected deps.runTui instead of the real one, and the explicit argv wins over process.argv', async () => {
      const fake = vi.fn(async () => {});
      process.argv = ['node', 'factory'];
      const res = await runMainWith({ runTui: fake }, 'tui');
      expect(res.exited).toBe(false);
      expect(fake).toHaveBeenCalledTimes(1);
      expect(fake).toHaveBeenCalledWith(
        expect.objectContaining({
          eventsFile: expect.stringMatching(/\.factory[\\/]state[\\/]events\.ndjson$/),
          repo: h.ghRepo,
        }),
      );
      expect(h.runTuiCalls).toHaveLength(0);
    });

    it('calls runTui with the events file, detected repo, and a GitHub-backed queue reader by default', async () => {
      const res = await runMain('tui');
      expect(res.exited).toBe(false);
      expect(h.runTuiCalls).toHaveLength(1);
      expect(h.runTuiCalls[0].eventsFile.endsWith(join('.factory', 'state', 'events.ndjson'))).toBe(true);
      expect(h.runTuiCalls[0].repo).toBe(h.ghRepo);
      expect(h.runTuiCalls[0].stopFile?.endsWith(join('.factory', 'state', 'STOP'))).toBe(true);
      expect(h.runTuiCalls[0].queueReader?.source).toBe('GitHub');
      expect(h.runTuiCalls[0].queueReader?.pollMs).toBe(30_000);
      expect(h.runTuiCalls[0].costsFile?.endsWith(join('.factory', 'state', 'costs.jsonl'))).toBe(true);
      expect(h.runTuiCalls[0].steeringDir?.endsWith(join('.factory', 'state', 'steering'))).toBe(true);
      expect(h.runTuiCalls[0].runsDir?.endsWith(join('.factory', 'state', 'runs'))).toBe(true);
    });

    it('default reader lists claimable GitHub issues with titles in lane order, ignoring a stale queue file (#1362)', async () => {
      writeFileSync(paths().queue, 'stale 1\nstale 2\nstale 3\n');
      const issues = [
        {
          number: 12,
          title: 'Second in cleanup',
          labels: ['factory:queued', 'factory:lane:cleanup', 'factory:order:2'],
        },
        {
          number: 11,
          title: 'First in cleanup',
          labels: ['factory:queued', 'factory:lane:cleanup', 'factory:order:1'],
        },
      ];
      const listForRepo = vi.fn(async ({ labels }: any) =>
        labels === 'factory:queued' ? { data: issues } : { data: [] },
      );
      h.octokit.rest.issues.listForRepo = listForRepo;

      await runMain('tui');
      expect(listForRepo).not.toHaveBeenCalled();

      const snapshot = await h.runTuiCalls[0].queueReader!.read();
      expect(snapshot).toEqual({
        entries: [
          { lane: 'cleanup', issue: 11, title: 'First in cleanup', status: 'queued' },
          { lane: 'cleanup', issue: 12, title: 'Second in cleanup', status: 'queued' },
        ],
      });
      expect(listForRepo).toHaveBeenCalledTimes(1);
    });

    it('--local-queue reads the queue file and its proposed count, and never calls GitHub (#1362)', async () => {
      writeFileSync(paths().queue, 'app 5\napp 6\n');
      writeFileSync(paths().queueProposed, 'app 7\n');
      const listForRepo = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.issues.listForRepo = listForRepo;

      const res = await runMain('tui', '--local-queue');
      expect(res.exited).toBe(false);
      const reader = h.runTuiCalls[0].queueReader!;
      expect(reader.source).toBe('local file');
      expect(reader.pollMs).toBeUndefined();
      expect(await reader.read()).toEqual({
        entries: [
          { lane: 'app', issue: 5 },
          { lane: 'app', issue: 6 },
        ],
        proposedCount: 1,
      });
      expect(listForRepo).not.toHaveBeenCalled();
    });

    it('without a GitHub token the default reader yields the no-token message and the TUI still starts', async () => {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      h.execSyncImpl = () => {
        throw new Error('gh not authenticated');
      };
      const listForRepo = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.issues.listForRepo = listForRepo;

      const res = await runMain('tui');
      expect(res.exited).toBe(false);
      const reader = h.runTuiCalls[0].queueReader!;
      expect(reader.source).toBe('GitHub');
      expect(await reader.read()).toEqual({ entries: [], error: 'no GitHub token — run `gh auth login`' });
      expect(listForRepo).not.toHaveBeenCalled();
    });

    it('surfaces a GitHub lookup failure as a rejected read the TUI renders, not a crash at startup', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => {
        throw new Error('GitHub API unavailable');
      });
      const res = await runMain('tui');
      expect(res.exited).toBe(false);
      await expect(h.runTuiCalls[0].queueReader!.read()).rejects.toThrow('GitHub API unavailable');
    });

    it('--help lists --local-queue with the same wording as factory run (#1362)', async () => {
      const originalWrite = process.stdout.write;
      const written: string[] = [];
      process.stdout.write = ((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      let res: Awaited<ReturnType<typeof runMain>>;
      try {
        res = await runMain('tui', '--help');
      } finally {
        process.stdout.write = originalWrite;
      }
      expect(res.exited).toBe(true);
      const text = written.join('').replace(/\s+/g, ' ');
      expect(text).toContain('--local-queue');
      expect(text).toContain('Read .factory/queue instead of claiming issues from GitHub Issues');
    });

    it('root --help ends with the env-var footer and the docs link', async () => {
      const originalWrite = process.stdout.write;
      const written: string[] = [];
      process.stdout.write = ((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      let res: Awaited<ReturnType<typeof runMain>>;
      try {
        res = await runMain('--help');
      } finally {
        process.stdout.write = originalWrite;
      }
      expect(res.exited).toBe(true);
      const text = written.join('');
      expect(text.indexOf('Advanced / experimental:')).toBeLessThan(text.indexOf('Common environment variables:'));
      expect(text).toContain('docs/config.example.yaml');
      expect(text).toContain('factory <command> --help');
    });

    it('root --help names factory doctor as the first step on its first line (#2558)', async () => {
      const originalWrite = process.stdout.write;
      const written: string[] = [];
      process.stdout.write = ((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      let res: Awaited<ReturnType<typeof runMain>>;
      try {
        res = await runMain('--help');
      } finally {
        process.stdout.write = originalWrite;
      }
      expect(res.exited).toBe(true);
      const lines = written.join('').split('\n');
      expect(lines[0]).toContain('factory doctor');
      expect(lines[0]).toMatch(/first step/i);
      expect(lines.slice(0, 10).join('\n')).toContain('Prerequisites:');
    });

    it('calls runTui with repo undefined when gh repo detection fails, and the reader says so', async () => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) throw new Error('gh not authenticated');
        return '';
      };
      const res = await runMain('tui');
      expect(res.exited).toBe(false);
      expect(h.runTuiCalls).toHaveLength(1);
      expect(h.runTuiCalls[0].repo).toBeUndefined();
      expect(await h.runTuiCalls[0].queueReader!.read()).toEqual({
        entries: [],
        error: 'repo detection failed — run inside a GitHub-backed checkout',
      });
    });
  });

  describe('triage', () => {
    it('triage exits 2 with gh auth login guidance when gh is not authenticated (#2592)', async () => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) {
          throw Object.assign(new Error('Command failed: gh repo view'), {
            stderr:
              'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n',
          });
        }
        return '';
      };
      const res = await runMain('triage');
      expect(res).toMatchObject({ exited: true, code: 2 });
      expect(errored()).toContain('gh is not authenticated');
      expect(errored()).toContain('gh auth login');
      expect(errored()).not.toContain('no GitHub remote detected');
    });

    const ghIssues = JSON.stringify([
      { number: 5, title: 'Five', labels: [{ name: 'bug' }], body: 'x'.repeat(10_000) },
      { number: 6, title: 'Six', labels: [], body: 'short' },
    ]);
    const execWithIssues = (cmd: string) => {
      if (cmd.includes('rev-parse')) return h.repoRoot;
      if (cmd.includes('gh repo view')) return h.ghRepo;
      if (cmd.includes('gh issue list')) return ghIssues;
      return '';
    };

    it('dispatches through the router, never spawns claude -p, and writes a valid proposal (#1650)', async () => {
      const cmds: string[] = [];
      h.execImpl = (cmd: string) => {
        cmds.push(cmd);
        return execWithIssues(cmd);
      };
      let seenPrompt = '';
      h.routerRun = async (task, prompt) => {
        expect(task).toBe('triage');
        seenPrompt = prompt;
        return { model: 'gpt-5.6-luna-high', output: '```\n# header\n\napp 5\napp #6\n```\n' };
      };
      await runMain('triage');
      expect(cmds.some((c) => c.includes('claude -p'))).toBe(false);
      expect(seenPrompt).toContain('#5: Five [labels: bug]');
      expect(seenPrompt).not.toContain('x'.repeat(1_500));
      const proposed = readFileSync(paths().queueProposed, 'utf-8');
      expect(proposed).toBe('# Triage queue (model gpt-5.6-luna-high)\n# header\napp 5\napp 6\n');
      expect(logged()).toContain('factory triage accept');
      expect(readFileSync(paths().events, 'utf-8')).toContain('with gpt-5.6-luna-high');
      const res = await runMain('triage', 'accept');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('2 issue(s) promoted');
    });

    it('passes --model to the router as the model override', async () => {
      h.execImpl = execWithIssues;
      let seenOpts: any;
      h.routerRun = async (_task, _prompt, opts) => {
        seenOpts = opts;
        return { model: 'gpt-5.6-terra-high', output: 'app 5\n' };
      };
      await runMain('triage', '--model', 'gpt-5.6-terra-high');
      expect(seenOpts.modelOverride).toBe('gpt-5.6-terra-high');
    });

    it('exits 1 when triage produces no proposal', async () => {
      h.execImpl = execWithIssues;
      h.routerRun = async () => ({ model: 'm', output: 'I could not decide.' });
      const res = await runMain('triage');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('no proposal');
    });

    it('exits 2 with the not-initialized message when .factory/ is missing', async () => {
      rmSync(paths().root, { recursive: true, force: true });
      const res = await runMain('triage');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('factory not initialized — run `factory init` first');
    });

    it('logs the planner failure detail and exits 1 with no proposal when the router fails', async () => {
      h.execImpl = execWithIssues;
      h.routerRun = async () => {
        throw new Error('codex crashed');
      };
      const res = await runMain('triage');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('no proposal');
      expect(errored()).toContain('codex crashed');
      expect(readFileSync(paths().events, 'utf-8')).toContain('triage planner failed');
    });
  });

  describe('triage accept', () => {
    beforeEach(() => {
      h.execImpl = (cmd: string) => (cmd.includes('rev-parse') ? h.repoRoot : '');
    });

    it('accepts a valid proposed queue', async () => {
      writeFileSync(paths().queueProposed, 'app 5\napp 6\n');
      await runMain('triage', 'accept');
      expect(existsSync(paths().queueProposed)).toBe(false);
      expect(readFileSync(paths().queue, 'utf-8')).toBe('app 5\napp 6\n');
      expect(logged()).toContain('queue accepted');
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('"type":"triage_accepted"');
      expect(events).toContain('5, 6');
    });

    it('accepts a proposal with a header, comments and a blank line before the first entry', async () => {
      const body = '# Triage queue — constitution: default-code\n# c1\n# c2\n# c3\n# c4\n\ngreet 1\n';
      writeFileSync(paths().queueProposed, body);
      const res = await runMain('triage', 'accept');
      expect(res.exited).toBe(false);
      expect(readFileSync(paths().queue, 'utf-8')).toBe(body);
      expect(logged()).toContain('queue accepted');
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('"type":"triage_accepted"');
      expect(events).toContain('1');
    });

    it('rejects an invalid queue and leaves it unchanged', async () => {
      writeFileSync(paths().queueProposed, 'app 5\napp notanumber\n');
      const res = await runMain('triage', 'accept');
      expect(res).toEqual({ exited: true, code: 1 });
      const err = errored();
      expect(err).toContain('invalid');
      expect(err).toContain('malformed');
      expect(existsSync(paths().queueProposed)).toBe(true);
      expect(readFileSync(paths().queueProposed, 'utf-8')).toBe('app 5\napp notanumber\n');
      expect(existsSync(paths().queue)).toBe(false);
    });

    it('reports nothing to accept when there is no proposed queue', async () => {
      const res = await runMain('triage', 'accept');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('nothing to accept');
    });

    it('--force skips validation and promotes as-is', async () => {
      writeFileSync(paths().queueProposed, 'app notanumber\n');
      await runMain('triage', 'accept', '--force');
      expect(existsSync(paths().queueProposed)).toBe(false);
      expect(readFileSync(paths().queue, 'utf-8')).toBe('app notanumber\n');
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('triage_accepted');
      expect(events).toContain('--force');
    });
  });

  describe('queue migrate', () => {
    beforeEach(() => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };
      h.octokit.rest.issues.createLabel = vi.fn(async () => ({}));
      h.octokit.rest.issues.addLabels = vi.fn(async () => ({}));
    });

    it('migrates valid local queue entries in per-lane order without rewriting the source queue', async () => {
      const source = 'daw 1055\ndocs 200\ndaw 993\n';
      writeFileSync(paths().queue, source);

      const res = await runMain('queue', 'migrate');

      expect(res.exited).toBe(false);
      expect(readFileSync(paths().queue, 'utf-8')).toBe(source);
      expect(logged()).toContain('queue migrated — 3 issue(s)');
      expect(h.octokit.rest.issues.addLabels).toHaveBeenNthCalledWith(1, {
        owner: 'on-par',
        repo: 'software-factory',
        issue_number: 1055,
        labels: ['factory:queued', 'factory:lane:daw', 'factory:order:1'],
      });
      expect(h.octokit.rest.issues.addLabels).toHaveBeenNthCalledWith(2, {
        owner: 'on-par',
        repo: 'software-factory',
        issue_number: 200,
        labels: ['factory:queued', 'factory:lane:docs', 'factory:order:1'],
      });
      expect(h.octokit.rest.issues.addLabels).toHaveBeenNthCalledWith(3, {
        owner: 'on-par',
        repo: 'software-factory',
        issue_number: 993,
        labels: ['factory:queued', 'factory:lane:daw', 'factory:order:2'],
      });
      expect(h.octokit.rest.issues.createLabel).toHaveBeenCalled();
    });

    it('rejects a missing local queue before creating or applying labels', async () => {
      const res = await runMain('queue', 'migrate');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('queue not found');
      expect(h.octokit.rest.issues.createLabel).not.toHaveBeenCalled();
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it('rejects an invalid local queue before creating or applying labels', async () => {
      writeFileSync(paths().queue, 'daw 1055\ndaw invalid\n');

      const res = await runMain('queue', 'migrate');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('queue is invalid');
      expect(h.octokit.rest.issues.createLabel).not.toHaveBeenCalled();
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it('rejects a queue with a duplicate issue number before any GitHub call', async () => {
      writeFileSync(paths().queue, 'daw 1055\ndocs 1055\n');

      const res = await runMain('queue', 'migrate');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('duplicate issue #1055');
      expect(h.octokit.rest.issues.get).not.toHaveBeenCalled();
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it('rejects an empty queue with no issue entries', async () => {
      writeFileSync(paths().queue, '\n# nothing queued yet\n');

      const res = await runMain('queue', 'migrate');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('no issue entries');
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it('aborts the whole migration when an entry is a pull request, not an issue', async () => {
      writeFileSync(paths().queue, 'daw 1055\n');
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'x', pull_request: {} } }));

      const res = await runMain('queue', 'migrate');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('is a pull request');
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it('previews the migration plan without mutating GitHub in --dry-run', async () => {
      const source = 'daw 1055\ndocs 200\n';
      writeFileSync(paths().queue, source);

      const res = await runMain('queue', 'migrate', '--dry-run');

      expect(res.exited).toBe(false);
      expect(logged()).toContain('dry run');
      expect(logged()).toContain('#1055 → lane daw, position 1');
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
      expect(h.octokit.rest.issues.createLabel).not.toHaveBeenCalled();
      expect(readFileSync(paths().queue, 'utf-8')).toBe(source);
    });

    it('aborts the whole migration when an entry is a closed issue', async () => {
      writeFileSync(paths().queue, 'daw 1055\n');
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'x', state: 'closed' } }));

      const res = await runMain('queue', 'migrate');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('closed');
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it('aborts the whole migration when an entry is inaccessible', async () => {
      writeFileSync(paths().queue, 'daw 1055\n');
      h.octokit.rest.issues.get = vi.fn(async () => {
        throw Object.assign(new Error('Not Found'), { status: 404 });
      });

      const res = await runMain('queue', 'migrate');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('inaccessible');
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it('surfaces a GitHub failure during apply as a CliExitError', async () => {
      writeFileSync(paths().queue, 'daw 1055\n');
      h.octokit.rest.issues.addLabels = vi.fn(async () => {
        throw new Error('label API down');
      });

      const res = await runMain('queue', 'migrate');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('queue migration failed');
    });

    it('migrates from an explicit --file path, leaving the default queue untouched', async () => {
      const legacyFile = join(paths().root, 'legacy-queue');
      writeFileSync(legacyFile, 'daw 1055\n');

      const res = await runMain('queue', 'migrate', '--file', '.factory/legacy-queue');

      expect(res.exited).toBe(false);
      expect(logged()).toContain('labelled from');
      expect(logged()).toContain(legacyFile);
      expect(existsSync(paths().queue)).toBe(false);
    });
  });

  describe('queue add', () => {
    beforeEach(() => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };
      h.octokit.rest.issues.createLabel = vi.fn(async () => ({}));
      h.octokit.rest.issues.addLabels = vi.fn(async () => ({}));
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.issues.listLabelsOnIssue = vi.fn(async () => ({ data: [] }));
    });

    it('queues explicit issues into a lane, applying queued/lane/order labels in order', async () => {
      const res = await runMain('queue', 'add', 'daw', '10', '11');

      expect(res.exited).toBe(false);
      expect(logged()).toContain('#10 queued');
      expect(logged()).toContain('#11 queued');
      expect(h.octokit.rest.issues.addLabels).toHaveBeenNthCalledWith(1, {
        owner: 'on-par',
        repo: 'software-factory',
        issue_number: 10,
        labels: ['factory:queued', 'factory:lane:daw', 'factory:order:1'],
      });
      expect(h.octokit.rest.issues.addLabels).toHaveBeenNthCalledWith(2, {
        owner: 'on-par',
        repo: 'software-factory',
        issue_number: 11,
        labels: ['factory:queued', 'factory:lane:daw', 'factory:order:2'],
      });
    });

    it('creates missing factory labels idempotently before applying them', async () => {
      await runMain('queue', 'add', 'daw', '10');

      expect(h.octokit.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'factory:queued' }),
      );
      expect(h.octokit.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'factory:lane:daw' }),
      );
      expect(h.octokit.rest.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'factory:order:1' }),
      );
    });

    it('exits nonzero and reports a per-issue failure without dropping the successful issue', async () => {
      h.octokit.rest.issues.addLabels = vi.fn(async ({ issue_number }: any) => {
        if (issue_number === 10) throw new Error('label API down');
        return {};
      });

      const res = await runMain('queue', 'add', 'daw', '10', '11');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('#10 failed');
      expect(logged()).toContain('#11 queued');
    });

    it('exits 2 for an invalid issue argument before any GitHub call', async () => {
      const res = await runMain('queue', 'add', 'daw', 'notanumber');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(h.octokit.rest.issues.createLabel).not.toHaveBeenCalled();
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it('--json prints exactly one JSON object with orders and created labels', async () => {
      const res = await runMain('queue', 'add', 'ops', '1', '2', '--json');

      expect(res.exited).toBe(false);
      expect(logged().trim().split('\n')).toHaveLength(1);
      const json = JSON.parse(logged());
      expect(json.ok).toBe(true);
      expect(json.issues.map((i: any) => [i.number, i.order])).toEqual([
        [1, 1],
        [2, 2],
      ]);
      expect(json.labelsCreated).toEqual(
        expect.arrayContaining(['factory:queued', 'factory:lane:ops', 'factory:order:1']),
      );
    });

    it('--json reports an already-queued issue with its order and no writes', async () => {
      h.octokit.rest.issues.listLabelsOnIssue = vi.fn(async ({ issue_number }: any) => ({
        data: issue_number === 1 ? [{ name: 'factory:order:5' }] : [],
      }));

      await runMain('queue', 'add', 'ops', '1', '2', '--json');

      const json = JSON.parse(logged());
      expect(json.issues[0]).toEqual({ number: 1, outcome: 'already-queued', order: 5, labelsAdded: [] });
      expect(h.octokit.rest.issues.addLabels).toHaveBeenCalledTimes(1);
      expect(h.octokit.rest.issues.addLabels).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 2 }));
    });

    it('--json reports no created labels when they already exist (422)', async () => {
      h.octokit.rest.issues.createLabel = vi.fn(async () => {
        throw { status: 422 };
      });

      await runMain('queue', 'add', 'ops', '1', '--json');

      expect(JSON.parse(logged()).labelsCreated).toEqual([]);
    });

    it('--json prints ok:false and exits 1 on a partial failure', async () => {
      h.octokit.rest.issues.addLabels = vi.fn(async ({ issue_number }: any) => {
        if (issue_number === 10) throw new Error('label API down');
        return {};
      });

      const res = await runMain('queue', 'add', 'daw', '10', '11', '--json');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged().trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(logged()).ok).toBe(false);
      expect(errored()).toContain('failed to queue');
    });

    it('--json exits 1 with empty stdout when the lane listing throws', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => {
        throw new Error('api down');
      });

      const res = await runMain('queue', 'add', 'ops', '1', '--json');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged()).toBe('');
      expect(errored()).toContain('queue add failed');
    });

    it('text mode prints only the per-issue lines (no event echo)', async () => {
      await runMain('queue', 'add', 'daw', '10', '11');

      expect(logged().split('\n').filter(Boolean)).toHaveLength(2);
      expect(logged()).not.toContain('queue_added');
    });

    it('records a queue_added event only when something was queued', async () => {
      await runMain('queue', 'add', 'ops', '1', '--json');
      expect(readFileSync(paths().events, 'utf-8')).toContain('"type":"queue_added"');

      rmSync(paths().events, { force: true });
      h.octokit.rest.issues.listLabelsOnIssue = vi.fn(async () => ({ data: [{ name: 'factory:order:1' }] }));
      await runMain('queue', 'add', 'ops', '1', '--json');
      expect(existsSync(paths().events)).toBe(false);
    });
  });

  describe('unpark', () => {
    let labels: string[];
    beforeEach(() => {
      labels = ['factory:parked', 'factory:lane:ops'];
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };
      h.octokit.rest.issues.createLabel = vi.fn(async () => ({}));
      h.octokit.rest.issues.addLabels = vi.fn(async ({ labels: add }: any) => {
        labels.push(...add.filter((l: string) => !labels.includes(l)));
        return {};
      });
      h.octokit.rest.issues.removeLabel = vi.fn(async ({ name }: any) => {
        labels = labels.filter((l) => l !== name);
        return {};
      });
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.issues.listLabelsOnIssue = vi.fn(async () => ({ data: labels.map((name) => ({ name })) }));
    });

    it('--json re-queues a parked issue and prints one object', async () => {
      const res = await runMain('unpark', '12', '--json');

      expect(res.exited).toBe(false);
      expect(logged().trim().split('\n')).toHaveLength(1);
      const json = JSON.parse(logged());
      expect(json).toMatchObject({ schemaVersion: 1, action: 'unpark', issue: 12, lane: 'ops', order: 1 });
      expect(h.octokit.rest.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({ labels: expect.arrayContaining(['factory:order:1']) }),
      );
      expect(h.octokit.rest.issues.removeLabel).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'factory:parked' }),
      );
    });

    it('text mode prints the position line', async () => {
      await runMain('unpark', '12');
      expect(logged()).toContain('#12 unparked → lane ops, position 1');
    });

    it('fails with [not-parked], empty stdout and no event when not parked', async () => {
      labels = ['factory:lane:ops'];
      const res = await runMain('unpark', '12', '--json');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged()).toBe('');
      expect(errored()).toContain('[not-parked]');
      expect(existsSync(paths().events)).toBe(false);
    });

    it('fails with [lane-required] when no lane label and no --lane', async () => {
      labels = ['factory:parked'];
      const res = await runMain('unpark', '12');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('[lane-required]');
    });

    it('records an issue_unparked event on success', async () => {
      await runMain('unpark', '12', '--json');
      expect(readFileSync(paths().events, 'utf-8')).toContain('"type":"issue_unparked"');
    });

    it('exits 2 for an invalid issue argument', async () => {
      const res = await runMain('unpark', 'abc');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });
  });

  describe('queue reconcile', () => {
    beforeEach(() => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({
        data: [
          {
            number: 10,
            title: 'Queued issue',
            labels: ['factory:queued', 'factory:lane:daw', 'factory:order:1'],
          },
        ],
      }));
    });

    it('exits 0 and reports no conflicts when no admission.json is present', async () => {
      const res = await runMain('queue', 'reconcile');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(logged()).toContain('1 queued issue(s), 0 conflict(s)');
      expect(logged()).toContain('no Factory App admission conflicts');
    });

    it('exits 1 and reports the conflict when admission state refuses the issue', async () => {
      writeFileSync(
        join(paths().state, 'admission.json'),
        JSON.stringify({
          version: 1,
          records: [{ issue: 10, state: 'executing', deliveryId: 'del-1' }],
        }),
      );

      const res = await runMain('queue', 'reconcile');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged()).toContain('1 queued issue(s), 1 conflict(s)');
      expect(logged()).toContain('[daw] #10:');
      expect(logged()).toContain('repair:');
    });

    it('--lane filters the report to a single lane', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({
        data: [
          { number: 10, labels: ['factory:queued', 'factory:lane:daw', 'factory:order:1'] },
          { number: 20, labels: ['factory:queued', 'factory:lane:other', 'factory:order:1'] },
        ],
      }));
      writeFileSync(
        join(paths().state, 'admission.json'),
        JSON.stringify({
          version: 1,
          records: [
            { issue: 10, state: 'executing' },
            { issue: 20, state: 'executing' },
          ],
        }),
      );

      const res = await runMain('queue', 'reconcile', '--lane', 'other');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged()).toContain('1 queued issue(s), 1 conflict(s)');
      expect(logged()).toContain('[other] #20:');
      expect(logged()).not.toContain('[daw]');
    });
  });

  describe('queue list', () => {
    const issue = (number: number, labels: string[], title?: string) => ({
      number,
      ...(title === undefined ? {} : { title }),
      labels,
    });

    beforeEach(() => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };
      h.octokit.rest.issues.addLabels = vi.fn(async () => ({}));
      h.octokit.rest.issues.removeLabel = vi.fn(async () => ({}));
      h.octokit.rest.issues.createLabel = vi.fn(async () => ({}));
    });

    const twoLanes = (): void => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({
        data: [
          issue(2, ['factory:queued', 'factory:lane:other', 'factory:order:5'], 'Two'),
          issue(3, ['factory:queued', 'factory:lane:daw', 'factory:order:9'], 'Three'),
          issue(1, ['factory:queued', 'factory:lane:daw', 'factory:order:2'], 'One'),
        ],
      }));
    };

    it('lists lanes sorted with items in order-label order, read-only', async () => {
      twoLanes();

      const res = await runMain('queue', 'list', '--json');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(JSON.parse(logged())).toEqual({
        schemaVersion: 1,
        lanes: [
          {
            lane: 'daw',
            items: [
              { issue: 1, title: 'One', status: 'queued', order: 1, claimedBy: null },
              { issue: 3, title: 'Three', status: 'queued', order: 2, claimedBy: null },
            ],
          },
          { lane: 'other', items: [{ issue: 2, title: 'Two', status: 'queued', order: 1, claimedBy: null }] },
        ],
      });
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
      expect(h.octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
      expect(h.octokit.rest.issues.createLabel).not.toHaveBeenCalled();
    });

    it('--lane returns only that lane', async () => {
      twoLanes();

      const res = await runMain('queue', 'list', '--json', '--lane', 'other');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(JSON.parse(logged()).lanes.map((l: { lane: string }) => l.lane)).toEqual(['other']);
    });

    it('reports parked status', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({
        data: [issue(4, ['factory:queued', 'factory:lane:daw', 'factory:order:1', 'factory:parked'])],
      }));

      await runMain('queue', 'list', '--json');

      expect(JSON.parse(logged()).lanes[0].items[0]).toMatchObject({ issue: 4, status: 'parked' });
    });

    it('reports in-progress status and claimant', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({
        data: [
          issue(5, [
            'factory:queued',
            'factory:lane:daw',
            'factory:order:1',
            'factory:in-progress',
            'factory:claimed-by:host-1',
          ]),
        ],
      }));

      await runMain('queue', 'list', '--json');

      expect(JSON.parse(logged()).lanes[0].items[0]).toMatchObject({
        issue: 5,
        status: 'in-progress',
        claimedBy: 'host-1',
      });
    });

    it('prints empty lanes when nothing is queued', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [] }));

      const res = await runMain('queue', 'list', '--json');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(JSON.parse(logged())).toEqual({ schemaVersion: 1, lanes: [] });
    });

    it('exits 1 with stderr only on a GitHub read failure', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => {
        throw Object.assign(new Error('Bad credentials'), { status: 401 });
      });

      const res = await runMain('queue', 'list', '--json');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged()).toBe('');
      expect(errored()).toContain('queue list failed');
      expect(errored()).toContain('Bad credentials');
    });

    it('exits 2 without --json and makes no GitHub call', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [] }));

      const res = await runMain('queue', 'list');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('requires --json');
      expect(logged()).toBe('');
      expect(h.octokit.rest.issues.listForRepo).not.toHaveBeenCalled();
    });
  });

  describe('runs', () => {
    const runsDir = (): string => FactoryCore.getFactoryPaths(h.repoRoot).runs;
    const writeRun = (n: number, updatedAt: string): void => {
      mkdirSync(runsDir(), { recursive: true });
      writeFileSync(join(runsDir(), `issue-${n}.json`), JSON.stringify({ issue: n, lane: 'daw', updatedAt }));
    };

    beforeEach(() => {
      h.execImpl = (cmd: string) => (cmd.includes('rev-parse') ? h.repoRoot : '');
    });

    it('prints runs newest first', async () => {
      writeRun(1, '2026-01-01T00:00:00Z');
      writeRun(2, '2026-01-03T00:00:00Z');
      writeRun(3, '2026-01-02T00:00:00Z');

      const res = await runMain('runs', '--json');

      expect(res).toEqual({ exited: false, code: undefined });
      const out = JSON.parse(logged()) as { schemaVersion: number; runs: Array<{ issue: number }> };
      expect(out.schemaVersion).toBe(1);
      expect(out.runs.map((r) => r.issue)).toEqual([2, 3, 1]);
    });

    it('honors --limit', async () => {
      writeRun(1, '2026-01-01T00:00:00Z');
      writeRun(2, '2026-01-03T00:00:00Z');

      await runMain('runs', '--json', '--limit', '1');

      expect((JSON.parse(logged()) as { runs: unknown[] }).runs).toHaveLength(1);
    });

    it('prints an empty list when there is no runs dir', async () => {
      const res = await runMain('runs', '--json');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(logged()).toBe('{"schemaVersion":1,"runs":[]}');
    });

    it('skips a malformed file with a stderr note and exit 0', async () => {
      writeRun(1, '2026-01-01T00:00:00Z');
      writeFileSync(join(runsDir(), 'issue-9.json'), '{not json');

      const res = await runMain('runs', '--json');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(errored()).toContain('skipped malformed issue-9.json');
      expect((JSON.parse(logged()) as { runs: unknown[] }).runs).toHaveLength(1);
    });

    it('exits 2 without --json', async () => {
      const res = await runMain('runs');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('requires --json');
      expect(logged()).toBe('');
    });

    it('exits 2 on an invalid --limit', async () => {
      const res = await runMain('runs', '--json', '--limit', '0');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('invalid --limit');
      expect(logged()).toBe('');
    });

    it('--diffstat exits 1 when the issue has no run', async () => {
      const res = await runMain('runs', '--json', '--diffstat', '99');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('no run for issue #99');
      expect(logged()).toBe('');
    });

    it('--diffstat exits 2 on an invalid issue', async () => {
      const res = await runMain('runs', '--json', '--diffstat', 'abc');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('invalid --diffstat');
      expect(logged()).toBe('');
    });

    it('--diffstat exits 2 without --json', async () => {
      const res = await runMain('runs', '--diffstat', '5');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('requires --json');
    });

    it('--diffstat exits 2 when combined with --limit', async () => {
      const res = await runMain('runs', '--json', '--diffstat', '5', '--limit', '2');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('cannot be combined');
    });

    it('--diffstat prints files null with reason no-branch for an empty branch', async () => {
      mkdirSync(runsDir(), { recursive: true });
      writeFileSync(
        join(runsDir(), 'issue-5.json'),
        JSON.stringify({ issue: 5, lane: 'daw', branch: '', updatedAt: '2026-01-01T00:00:00Z' }),
      );

      const res = await runMain('runs', '--json', '--diffstat', '5');

      expect(res).toEqual({ exited: false, code: undefined });
      const out = JSON.parse(logged()) as { files: unknown; reason: string; base: unknown };
      expect(out.files).toBeNull();
      expect(out.reason).toBe('no-branch');
      expect(typeof out.base).toBe('string');
    });
  });

  describe('queue clear', () => {
    const removeLabel = vi.fn();
    const addLabels = vi.fn();

    beforeEach(() => {
      removeLabel.mockClear();
      addLabels.mockClear();
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };
      h.octokit.rest.issues.removeLabel = removeLabel;
      h.octokit.rest.issues.addLabels = addLabels;
      const labelsFor = (n: number): string[] =>
        n === 10
          ? ['factory:queued', 'factory:lane:daw', 'factory:order:1']
          : n === 11
            ? ['factory:queued', 'factory:lane:daw', 'factory:in-progress', 'factory:claimed-by:host-1']
            : ['factory:queued', 'factory:lane:daw'];
      h.octokit.rest.issues.listLabelsOnIssue = vi.fn(async ({ issue_number }: { issue_number: number }) => ({
        data: labelsFor(issue_number).map((name) => ({ name })),
      }));
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({
        data: [
          { number: 10, title: 'Queued issue', labels: labelsFor(10) },
          { number: 11, labels: labelsFor(11) },
          { number: 12, labels: labelsFor(12) },
        ],
      }));
    });

    it('--dry-run lists every queued issue with its lane and exits 0 without writing', async () => {
      const res = await runMain('queue', 'clear', '--dry-run');

      expect(res).toEqual({ exited: false, code: undefined });
      for (const n of [10, 11, 12]) expect(logged()).toContain(`#${n} [lane daw]`);
      expect(logged()).toContain('would-skip');
      expect(logged()).toContain('3 queued issue(s): 2 would-clear, 1 would-skip');
      expect(removeLabel).not.toHaveBeenCalled();
      expect(addLabels).not.toHaveBeenCalled();
    });

    it('exits 2 without --dry-run or --yes, after printing the preview', async () => {
      const res = await runMain('queue', 'clear');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(logged()).toContain('#10 [lane daw] would-clear');
      expect(errored()).toContain('--yes');
      expect(removeLabel).not.toHaveBeenCalled();
      expect(addLabels).not.toHaveBeenCalled();
    });

    it('--yes removes queue labels, keeps lanes, and skips claimed issues', async () => {
      const res = await runMain('queue', 'clear', '--yes');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(logged()).toContain('#10 [lane daw] cleared');
      expect(logged()).toContain('#11 [lane daw] skipped — claimed');
      expect(logged()).toContain('#12 [lane daw] cleared');
      expect(logged()).toContain('3 queued issue(s): 2 cleared, 1 skipped');
      const removed = removeLabel.mock.calls.map(([arg]) => [arg.issue_number, arg.name]);
      expect(removed).toContainEqual([10, 'factory:queued']);
      expect(removed).toContainEqual([10, 'factory:order:1']);
      expect(removed).toContainEqual([12, 'factory:queued']);
      expect(removed.some(([n]) => n === 11)).toBe(false);
      expect(removed.some(([, name]) => String(name).startsWith('factory:lane:'))).toBe(false);
      expect(addLabels).not.toHaveBeenCalled();
    });

    it('--yes on an empty queue reports it and does not remove labels', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [] }));

      const res = await runMain('queue', 'clear', '--yes');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(logged()).toContain('already empty');
      expect(removeLabel).not.toHaveBeenCalled();
    });

    it('reports an already-empty queue and exits 0', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [] }));

      const res = await runMain('queue', 'clear', '--dry-run');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(logged()).toContain('already empty');
    });

    describe('--lane', () => {
      const issueLabels: Record<number, string[]> = {
        10: ['factory:queued', 'factory:lane:ops', 'factory:order:1'],
        11: ['factory:queued', 'factory:lane:review', 'factory:order:2'],
        12: ['factory:queued', 'factory:lane:ops'],
      };
      let listForRepo: ReturnType<typeof vi.fn>;

      beforeEach(() => {
        h.octokit.rest.issues.listLabelsOnIssue = vi.fn(async ({ issue_number }: { issue_number: number }) => ({
          data: (issueLabels[issue_number] ?? []).map((name) => ({ name })),
        }));
        listForRepo = vi.fn(async ({ labels }: { labels: string }) => {
          const wanted = labels.split(',');
          return {
            data: Object.entries(issueLabels)
              .filter(([, ls]) => wanted.every((w) => ls.includes(w)))
              .map(([n, ls]) => ({ number: Number(n), labels: ls })),
          };
        });
        h.octokit.rest.issues.listForRepo = listForRepo;
      });

      it('--dry-run lists only that lane and writes nothing', async () => {
        const res = await runMain('queue', 'clear', '--lane', 'ops', '--dry-run');

        expect(res).toEqual({ exited: false, code: undefined });
        expect(listForRepo).toHaveBeenCalledWith(
          expect.objectContaining({ labels: 'factory:queued,factory:lane:ops' }),
        );
        expect(logged()).toContain('#10 [lane ops]');
        expect(logged()).toContain('#12 [lane ops]');
        expect(logged()).not.toContain('#11');
        expect(removeLabel).not.toHaveBeenCalled();
        expect(addLabels).not.toHaveBeenCalled();
      });

      it('--yes clears only that lane and never touches other lanes or lane labels', async () => {
        const res = await runMain('queue', 'clear', '--lane', 'ops', '--yes');

        expect(res).toEqual({ exited: false, code: undefined });
        const removed = removeLabel.mock.calls.map(([arg]) => [arg.issue_number, arg.name]);
        expect(removed).toContainEqual([10, 'factory:queued']);
        expect(removed).toContainEqual([12, 'factory:queued']);
        expect(removed.some(([n]) => n === 11)).toBe(false);
        expect(removed.some(([, name]) => String(name).startsWith('factory:lane:'))).toBe(false);
      });

      it('reports an empty lane and exits 0 without writing', async () => {
        const res = await runMain('queue', 'clear', '--lane', 'docs', '--yes');

        expect(res).toEqual({ exited: false, code: undefined });
        expect(logged()).toContain('already empty for lane docs');
        expect(removeLabel).not.toHaveBeenCalled();
      });
    });
  });

  describe('resume --from check (#2564)', () => {
    const recordPath = () => join(paths().plans, 'issue-5.check-resume.json');
    const configEnvFail = () => {
      h.checkResult = {
        passed: false,
        summary: { results: [], failures: 1 },
        reworkRounds: 0,
        environment: { baseSha: 'b'.repeat(40), failingChecks: ['unknown-checker'], cause: 'config', logPaths: [] },
      };
    };
    const writeRecord = (worktree: string) => {
      mkdirSync(paths().plans, { recursive: true });
      writeFileSync(
        recordPath(),
        JSON.stringify({
          issue: 5,
          branch: 'kept-branch',
          worktree,
          diffBase: 'dbase',
          route: 'claude',
          model: 'kept-model',
          buildMinutes: 40,
          fixTarget: '.factory/constitution.md:3',
          preservedAt: '2026-01-01T00:00:00.000Z',
        }),
      );
    };

    it('a config-caused CHECK failure parks and records no resume point (#2583)', async () => {
      configEnvFail();
      const err = await shipIssue(5, {}, { repoRoot: h.repoRoot, ghRepo: h.ghRepo }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LaneParkError);
      expect((err as LaneParkError).reason).toBe('config');
      expect(existsSync(recordPath())).toBe(false);
      expect(readFileSync(paths().events, 'utf-8')).toContain('factory unpark 5');
    });

    it('resume <issue> --from check runs CHECK in the kept worktree without setupWorktree, planPhase or buildPhase', async () => {
      const kept = join(h.repoRoot, 'kept-worktree');
      mkdirSync(kept, { recursive: true });
      writeRecord(kept);
      const res = await runMain('resume', '5', '--from', 'check');
      expect(res.exited).toBe(false);
      expect(setupWorktree).not.toHaveBeenCalled();
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.buildPhase).not.toHaveBeenCalled();
      expect(phases.checkPhase.mock.calls[0][0]).toMatchObject({
        worktree: kept,
        diffBase: 'dbase',
        reworkModel: 'kept-model',
      });
      expect(existsSync(recordPath())).toBe(false);
    });

    it.each([
      ['no --from', ['resume', '5']],
      ['an unsupported phase', ['resume', '5', '--from', 'build']],
      ['--from without an issue', ['resume', '--from', 'check']],
      ['an invalid issue', ['resume', 'abc', '--from', 'check']],
      ['no preserved build', ['resume', '5', '--from', 'check']],
    ])('exits 2 and leaves STOP untouched for %s', async (_name, args) => {
      writeFileSync(paths().stop, '');
      const res = await runMain(...args);
      expect(res).toEqual({ exited: true, code: 2 });
      expect(existsSync(paths().stop)).toBe(true);
      expect(phases.checkPhase).not.toHaveBeenCalled();
    });

    it('exits 2 when the recorded worktree no longer exists', async () => {
      writeRecord(join(h.repoRoot, 'gone'));
      const res = await runMain('resume', '5', '--from', 'check');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(phases.checkPhase).not.toHaveBeenCalled();
    });
  });

  describe('stop / resume', () => {
    it('stop writes the STOP file', async () => {
      await runMain('stop');
      expect(existsSync(paths().stop)).toBe(true);
      expect(logged()).toContain('STOP set');
    });

    it('stop routes git rev-parse through the injected exec seam', async () => {
      const commands: string[] = [];
      const recordingExec = async (cmd: string) => {
        commands.push(cmd);
        return { stdout: `${h.repoRoot}\n`, stderr: '' };
      };
      await runMainWith({ exec: recordingExec }, 'stop');
      expect(commands).toContain('git rev-parse --show-toplevel');
      expect(existsSync(paths().stop)).toBe(true);
    });

    it('resume removes an existing STOP file', async () => {
      writeFileSync(paths().stop, '');
      await runMain('resume');
      expect(existsSync(paths().stop)).toBe(false);
      expect(logged()).toContain('STOP cleared');
    });

    it('resume is a no-op when there is no STOP file', async () => {
      await runMain('resume');
      expect(logged()).toContain('STOP cleared');
    });

    it('text output is byte-identical without --json', async () => {
      await runMain('stop');
      expect(logged()).toBe('STOP set — lanes halt between issues');
    });

    it('resume text output is byte-identical without --json', async () => {
      await runMain('resume');
      expect(logged()).toBe('STOP cleared');
    });

    it('stop --json prints one JSON object when not stopped', async () => {
      await runMain('stop', '--json');
      expect(existsSync(paths().stop)).toBe(true);
      expect(logged().split('\n')).toHaveLength(1);
      expect(JSON.parse(logged())).toEqual({
        schemaVersion: 1,
        ok: true,
        action: 'stop',
        repo: h.ghRepo,
        stopFlag: { before: false, after: true },
      });
    });

    it('stop --json is idempotent when already stopped', async () => {
      writeFileSync(paths().stop, '');
      await runMain('stop', '--json');
      expect(existsSync(paths().stop)).toBe(true);
      expect(JSON.parse(logged())).toMatchObject({ ok: true, stopFlag: { before: true, after: true } });
    });

    it('resume --json reports before/after with and without STOP', async () => {
      writeFileSync(paths().stop, '');
      await runMain('resume', '--json');
      expect(existsSync(paths().stop)).toBe(false);
      expect(JSON.parse(logged())).toMatchObject({ action: 'resume', stopFlag: { before: true, after: false } });
    });

    it('stop leaves an existing STOP file untouched (exclusive create, no rewrite)', async () => {
      writeFileSync(paths().stop, 'set by lane');
      await runMain('stop', '--json');
      expect(readFileSync(paths().stop, 'utf-8')).toBe('set by lane');
      expect(JSON.parse(logged())).toMatchObject({ stopFlag: { before: true, after: true } });
    });

    it('resume surfaces unlink errors other than a missing STOP file', async () => {
      mkdirSync(join(paths().stop, 'nested'), { recursive: true });
      await expect(runMain('resume', '--json')).rejects.toMatchObject({ code: expect.stringMatching(/^E/) });
      expect(existsSync(paths().stop)).toBe(true);
    });

    it('resume --json is ok when STOP was not set', async () => {
      await runMain('resume', '--json');
      expect(JSON.parse(logged())).toMatchObject({ ok: true, stopFlag: { before: false, after: false } });
    });

    it('stop --json has the same shape as the golden fixture', async () => {
      await runMain('stop', '--json');
      const golden = JSON.parse(
        readFileSync(new URL('./__fixtures__/stop-resume-json/stop.json', import.meta.url), 'utf-8'),
      ) as { stopFlag: object };
      const out = JSON.parse(logged()) as { stopFlag: object };
      expect(Object.keys(out)).toEqual(Object.keys(golden));
      expect(Object.keys(out.stopFlag)).toEqual(Object.keys(golden.stopFlag));
    });

    it('records stop-file-set / stop-file-cleared events without echoing them', async () => {
      const types = () =>
        readFileSync(paths().events, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { type: string }).type);
      await runMain('stop');
      expect(types()).toEqual(['stop-file-set']);
      expect(logged()).toBe('STOP set — lanes halt between issues');
      await runMain('resume');
      expect(types()).toEqual(['stop-file-set', 'stop-file-cleared']);
    });

    it('stop --json fails with exit 2 and writes nothing when repo lookup fails', async () => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) throw new Error('gh not authenticated');
        return '';
      };
      const res = await runMain('stop', '--json');
      expect(res).toMatchObject({ exited: true, code: 2 });
      expect(errored()).toContain('no GitHub remote detected');
      expect(logged()).toBe('');
      expect(existsSync(paths().stop)).toBe(false);
    });
  });

  describe('proxy', () => {
    it('starts the foreground proxy, prints routes, and shuts down cleanly on SIGINT', async () => {
      h.factoryConfig = {
        ...h.factoryConfig,
        environment: { proxy: { enabled: true, port: 0, domain: 'factory.localhost' } },
      };
      writeFileSync(
        join(paths().state, 'ports.json'),
        JSON.stringify({
          version: 1,
          leases: [
            {
              worktreeId: '/repo/ship-it-296',
              branch: 'ship-it/296',
              port: 3142,
              pid: process.pid,
              acquiredAt: new Date().toISOString(),
            },
          ],
        }),
      );

      const runPromise = runMain('proxy');
      while (!logged().includes('listening on')) {
        await new Promise((r) => setTimeout(r, 5));
      }
      process.emit('SIGINT');
      const res = await runPromise;

      expect(res.exited).toBe(true);
      expect(res.code).toBe(0);
      expect(logged()).toContain('ship-it-296.factory.localhost -> 127.0.0.1:3142');
      expect(existsSync(join(paths().state, 'proxy.json'))).toBe(false);
    });

    it('warns but still starts when environment.proxy.enabled is false (the command is the explicit opt-in)', async () => {
      h.factoryConfig = {
        ...h.factoryConfig,
        environment: { proxy: { enabled: false, port: 0, domain: 'factory.localhost' } },
      };

      const runPromise = runMain('proxy');
      while (!logged().includes('listening on')) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(logged()).toContain('explicit opt-in');
      process.emit('SIGINT');
      await runPromise;
    });
  });

  describe('daemon', () => {
    it('starts the foreground factoryd, serves the registry, and shuts down cleanly on SIGINT', async () => {
      const registryFile = join(paths().state, 'registry.json');
      writeFileSync(
        registryFile,
        JSON.stringify({
          version: 1,
          repos: {
            'on-par/software-factory': {
              path: h.repoRoot,
              attachedAt: '2026-01-01T00:00:00.000Z',
              state: 'active',
            },
          },
        }),
      );

      const runPromise = runMain('daemon', 'run', '--port', '0', '--registry', registryFile);
      while (!logged().includes('listening on 127.0.0.1:')) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(logged()).toContain(registryFile);

      // Runtime state lives in dirname(registryFile) while the daemon is up (#1177).
      const pidFile = join(paths().state, 'daemon.pid');
      const portFile = join(paths().state, 'daemon.port');
      const logFile = join(paths().state, 'daemon.log');
      const boundPort = Number(/listening on 127\.0\.0\.1:(\d+)/.exec(logged())![1]);
      expect(readFileSync(pidFile, 'utf-8').trim()).toBe(String(process.pid));
      expect(JSON.parse(readFileSync(portFile, 'utf-8'))).toEqual({
        pid: process.pid,
        port: boundPort,
        host: '127.0.0.1',
      });

      process.emit('SIGINT');
      const res = await runPromise;

      expect(res.exited).toBe(true);
      expect(res.code).toBe(0);
      expect(existsSync(pidFile)).toBe(false);
      expect(existsSync(portFile)).toBe(false);
      expect(readFileSync(logFile, 'utf-8')).toContain(`factoryd: listening on 127.0.0.1:${boundPort}`);
    });

    it('daemon run --help lists --update-mode and the deprecated --auto-update', async () => {
      const originalWrite = process.stdout.write.bind(process.stdout);
      const written: string[] = [];
      process.stdout.write = ((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;

      let res: Awaited<ReturnType<typeof runMain>>;
      try {
        res = await runMain('daemon', 'run', '--help');
      } finally {
        process.stdout.write = originalWrite;
      }

      expect(res.exited).toBe(true);
      const text = written.join('').replace(/\s+/g, ' ');
      expect(text).toContain('--update-mode');
      expect(text).toContain('manual, stable');
      expect(text).toContain('--auto-update');
      expect(text).toContain('Deprecated');
    });

    it('accepts --auto-update and starts and stops exactly like the default run', async () => {
      const registryFile = join(paths().state, 'registry.json');
      writeFileSync(registryFile, JSON.stringify({ version: 1, repos: {} }));

      const runPromise = runMain('daemon', 'run', '--auto-update', '--port', '0', '--registry', registryFile);
      while (!logged().includes('listening on 127.0.0.1:')) {
        await new Promise((r) => setTimeout(r, 5));
      }

      process.emit('SIGINT');
      const res = await runPromise;

      expect(res.exited).toBe(true);
      expect(res.code).toBe(0);
    });

    it('exits with code 2 on an invalid --port and never binds', async () => {
      const res = await runMain('daemon', 'run', '--port', 'abc');
      expect(res.exited).toBe(true);
      expect(res.code).toBe(2);
      expect(logged()).not.toContain('listening on');
    });

    it('exits with code 2 on --update-mode nightly and lists the valid modes', async () => {
      const registryFile = join(paths().state, 'registry.json');
      const res = await runMain('daemon', 'run', '--update-mode', 'nightly', '--registry', registryFile);
      expect(res.exited).toBe(true);
      expect(res.code).toBe(2);
      expect(logged()).not.toContain('listening on');
    });

    const bootout = { cmd: 'launchctl', args: ['bootout', `gui/501/${FACTORYD_LABEL}`] };
    const print = { cmd: 'launchctl', args: ['print', `gui/501/${FACTORYD_LABEL}`] };

    it('daemon start installs the plist and bootstraps it through launchctl', async () => {
      const { plistPath } = factorydFiles(h.daemonHome);
      const res = await runMain('daemon', 'start');
      expect(res.exited).toBe(false);
      expect(h.daemonExecCalls).toEqual([
        bootout,
        { cmd: 'launchctl', args: ['bootstrap', 'gui/501', plistPath] },
        print,
      ]);
      expect(existsSync(plistPath)).toBe(true);
      expect(readFileSync(plistPath, 'utf-8')).toContain('/opt/factory/cli.js');
      expect(h.daemonOut.join('')).toContain('factoryd: installed');
    });

    it('daemon stop boots the agent out through launchctl', async () => {
      const res = await runMain('daemon', 'stop');
      expect(res.exited).toBe(false);
      expect(h.daemonExecCalls).toEqual([bootout]);
      expect(h.daemonOut.join('')).toContain('factoryd: stopped');
    });

    it('daemon status reports the pid and uptime of the running agent', async () => {
      h.daemonExecImpl = (cmd) =>
        cmd === 'launchctl'
          ? { code: 0, stdout: '\tpid = 4242\n', stderr: '' }
          : { code: 0, stdout: '01:02\n', stderr: '' };
      const res = await runMain('daemon', 'status');
      expect(res.exited).toBe(false);
      expect(h.daemonExecCalls).toEqual([print, { cmd: 'ps', args: ['-o', 'etime=', '-p', '4242'] }]);
      const out = h.daemonOut.join('');
      expect(out).toContain('factoryd: running (pid 4242, uptime 01:02)');
      expect(out).toContain('attached repos: none');
    });

    it('daemon status --json prints one JSON object for the running agent', async () => {
      h.daemonExecImpl = (cmd) =>
        cmd === 'launchctl'
          ? { code: 0, stdout: '\tpid = 4242\n', stderr: '' }
          : { code: 0, stdout: '01:02\n', stderr: '' };
      const res = await runMain('daemon', 'status', '--json');
      expect(res.exited).toBe(false);
      expect(JSON.parse(h.daemonOut.join(''))).toEqual({
        schemaVersion: 1,
        running: true,
        pid: 4242,
        uptimeSec: 62,
        plistInstalled: false,
        repos: [],
      });
    });

    it('daemon status --json on linux exits 2 with nothing on stdout', async () => {
      h.daemonPlatform = 'linux';
      const res = await runMain('daemon', 'status', '--json');
      expect(res.exited).toBe(true);
      expect(res.code).toBe(2);
      expect(h.daemonOut).toEqual([]);
      expect(errored()).toContain('requires macOS launchd');
    });

    it('daemon logs -n prints the last N lines of the log', async () => {
      const { logPath } = factorydFiles(h.daemonHome);
      mkdirSync(dirname(logPath), { recursive: true });
      writeFileSync(logPath, Array.from({ length: 10 }, (_, i) => `line${i + 1}\n`).join(''));
      const res = await runMain('daemon', 'logs', '-n', '3');
      expect(res.exited).toBe(false);
      expect(h.daemonOut.join('')).toBe('line8\nline9\nline10\n');
      expect(h.daemonExecCalls).toEqual([]);
    });

    it('daemon logs -f returns early when no log exists yet', async () => {
      // Never create a log file here: follow mode would then block on SIGINT.
      const res = await runMain('daemon', 'logs', '-f', '-n', '7');
      expect(res.exited).toBe(false);
      expect(h.daemonOut.join('')).toContain('no daemon log yet');
    });

    it('maps DaemonCtlError onto the CLI exit code', async () => {
      h.daemonPlatform = 'linux';
      const res = await runMain('daemon', 'status');
      expect(res.exited).toBe(true);
      expect(res.code).toBe(2);
      expect(h.daemonExecCalls).toEqual([]);
    });

    it('refuses to start when a live daemon holds the pid file, leaving it untouched', async () => {
      const registryFile = join(paths().state, 'registry.json');
      const pidFile = join(paths().state, 'daemon.pid');
      // The test process itself is alive by construction.
      writeFileSync(pidFile, `${process.pid}\n`);

      const res = await runMain('daemon', 'run', '--port', '0', '--registry', registryFile);

      expect(res.exited).toBe(true);
      expect(res.code).toBe(2);
      expect(errored()).toContain(`factoryd already running (pid ${process.pid})`);
      expect(readFileSync(pidFile, 'utf-8')).toBe(`${process.pid}\n`);
      expect(logged()).not.toContain('listening on');
    });

    it('a stale pid file from a killed daemon does not block a restart', async () => {
      const registryFile = join(paths().state, 'registry.json');
      writeFileSync(registryFile, JSON.stringify({ version: 1, repos: {} }));
      const pidFile = join(paths().state, 'daemon.pid');
      // A real (bypassing the module mock) short-lived child yields a pid that
      // is guaranteed dead once spawnSync returns.
      const { spawnSync } = await vi.importActual<typeof ChildProcess>('node:child_process');
      const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
      writeFileSync(pidFile, `${deadPid}\n`);

      const runPromise = runMain('daemon', 'run', '--port', '0', '--registry', registryFile);
      while (!logged().includes('listening on 127.0.0.1:')) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(logged()).toContain(`removed stale pid file (pid ${deadPid})`);
      expect(readFileSync(pidFile, 'utf-8').trim()).toBe(String(process.pid));

      process.emit('SIGINT');
      const res = await runPromise;
      expect(res.exited).toBe(true);
      expect(res.code).toBe(0);
    });
  });

  describe('worktree gc', () => {
    it('dry-run calls sweepWorktrees with dryRun: true and takes no lock', async () => {
      h.gcReport = { removed: [], kept: 3, dryRun: true };
      const lockHeld: boolean[] = [];
      ops.sweepWorktrees.mockImplementationOnce(async () => {
        lockHeld.push(existsSync(paths().gitLock));
        return h.gcReport;
      });
      const res = await runMain('worktree', 'gc', '--dry-run');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).toHaveBeenCalledWith(
        expect.objectContaining({ repoRoot: h.repoRoot, ttlDays: 7, dryRun: true }),
        expect.anything(),
      );
      expect(lockHeld).toEqual([false]);
      expect(logged()).toContain('GC_REPORT:dry:removed=0:kept=3');
    });

    it('--ttl-days overrides the config default', async () => {
      const res = await runMain('worktree', 'gc', '--ttl-days', '3');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).toHaveBeenCalledWith(expect.objectContaining({ ttlDays: 3 }), expect.anything());
    });

    it('--branch-prefix sf is passed to sweepWorktrees', async () => {
      const res = await runMain('worktree', 'gc', '--branch-prefix', 'sf');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).toHaveBeenCalledWith(
        expect.objectContaining({ branchPrefix: 'sf' }),
        expect.anything(),
      );
    });

    it('exits 2 when --branch-prefix has no letters or digits', async () => {
      const res = await runMain('worktree', 'gc', '--branch-prefix', '!!!');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('--branch-prefix');
    });

    it('exits 2 on a non-numeric --ttl-days', async () => {
      const res = await runMain('worktree', 'gc', '--ttl-days', 'nope');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('--ttl-days');
    });
  });

  describe('reset', () => {
    it('prints one summary line per issue and exits 0 when nothing is found', async () => {
      const lockHeld: boolean[] = [];
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        lockHeld.push(existsSync(paths().gitLock));
        return '';
      };
      const res = await runMain('reset', '555', '556');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('#555: nothing to reset');
      expect(logged()).toContain('#556: nothing to reset');
      expect(lockHeld).toContain(true);
    });

    it('--dry-run previews without taking the git lock', async () => {
      const lockHeld: boolean[] = [];
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        lockHeld.push(existsSync(paths().gitLock));
        return '';
      };
      const res = await runMain('reset', '555', '--dry-run');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('#555 (dry run): nothing to reset');
      expect(lockHeld.length).toBeGreaterThan(0);
      expect(lockHeld.every((held) => !held)).toBe(true);
    });

    it('runs the dirty probe through exec and keeps a dirty worktree (#1789)', async () => {
      const wt = join(h.repoRoot, '..', 'wt-777');
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('worktree list')) return `worktree ${wt}\nHEAD abc\nbranch refs/heads/ship-it/777-x\n`;
        if (cmd.includes('git status')) return ' M a.ts\n';
        return '';
      };
      const res = await runMain('reset', '777', '--dry-run');
      expect(res.exited).toBe(false);
      expect(logged()).toContain(`would keep worktree ${wt} (uncommitted changes; pass --force to remove)`);
      expect(logged()).not.toContain('would remove worktree');
    });

    it('exits 2 on a non-numeric issue', async () => {
      const res = await runMain('reset', 'abc');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('is not an issue number');
    });

    it('exits 2 when --branch-prefix has no letters or digits', async () => {
      const res = await runMain('reset', '5', '--branch-prefix', '!!!');
      expect(res).toEqual({ exited: true, code: 2 });
    });
  });

  describe('local-small-dry-run', () => {
    it('creates the dry-run plan and context and prints their paths', async () => {
      const res = await runMain('local-small-dry-run', '5');
      expect(res.exited).toBe(false);
      const out = logged();
      expect(out).toContain('/tmp/plan.md');
      expect(out).toContain('/tmp/ctx.md');
    });
  });

  describe('local-small-overnight', () => {
    it('exits 2 mentioning the expected path when the queue file is missing', async () => {
      const res = await runMain('local-small-overnight');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain(join(paths().state, 'local-small', 'overnight-queue'));
    });

    it('exits 2 when the queue file has only malformed lines', async () => {
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'not a valid line\n');
      const res = await runMain('local-small-overnight');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('malformed');
    });

    it('runs the happy path: ships the queued issue and records it as ready', async () => {
      h.diagnoses = [
        { model: 'w', provider: 'openai', tiers: ['worker'], reachable: true, experimental: false, reason: 'ok' },
      ];
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'overnight 5\n');

      const res = await runMain('local-small-overnight');

      expect(res.exited).toBe(false);
      expect(logged()).toContain('overnight ready: 1');

      const state = JSON.parse(readFileSync(join(queueDir, 'overnight-state.json'), 'utf-8'));
      expect(state.items).toEqual([expect.objectContaining({ issue: 5, status: 'ready' })]);
    });

    it('exits 4 mentioning halted when preflight fails', async () => {
      h.claudeAvailable = false;
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'overnight 5\n');

      const res = await runMain('local-small-overnight');

      expect(res).toEqual({ exited: true, code: 4 });
      expect(errored()).toContain('halted');
    });

    it('exits 4 mentioning no reachable local worker when no worker-tier model is reachable', async () => {
      h.diagnoses = [
        { model: 'w', provider: 'openai', tiers: ['worker'], reachable: false, experimental: false, reason: 'no key' },
      ];
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'overnight 5\n');

      const res = await runMain('local-small-overnight');

      expect(res).toEqual({ exited: true, code: 4 });
      expect(errored()).toContain('no reachable local worker model');
    });

    it('parks an item, reports it, and logs overnight-park when shipIssue escalates', async () => {
      h.diagnoses = [
        { model: 'w', provider: 'openai', tiers: ['worker'], reachable: true, experimental: false, reason: 'ok' },
      ];
      h.planResult = { ok: false, route: 'claude', escalate: 'needs human' };
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'overnight 5\n');

      const res = await runMain('local-small-overnight');

      expect(res.exited).toBe(false);
      expect(logged()).toContain('overnight parked: 1');
      expect(logged()).toContain('parked');
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('overnight-park');

      const state = JSON.parse(readFileSync(join(queueDir, 'overnight-state.json'), 'utf-8'));
      expect(state.items).toEqual([expect.objectContaining({ issue: 5, status: 'parked' })]);
    });

    // Regression (#681): the curated overnight queue needs a human to prune it —
    // a closed issue maps to 'parked', not 'ready' or 'failed'.
    it('parks a closed issue for a human, reports it, and logs overnight-park', async () => {
      h.diagnoses = [
        { model: 'w', provider: 'openai', tiers: ['worker'], reachable: true, experimental: false, reason: 'ok' },
      ];
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix the bug', state: 'closed' } }));
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'overnight 5\n');

      const res = await runMain('local-small-overnight');

      expect(res.exited).toBe(false);
      expect(logged()).toContain('overnight parked: 1');
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('skipped-already-closed');

      const state = JSON.parse(readFileSync(join(queueDir, 'overnight-state.json'), 'utf-8'));
      expect(state.items).toEqual([expect.objectContaining({ issue: 5, status: 'parked' })]);
    });
  });

  describe('resume-approved', () => {
    it('exits 2 when --branch-prefix has no letters or digits', async () => {
      const res = await runMain('resume-approved', '--branch-prefix', '!!!');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('--branch-prefix');
    });

    it('resolves cleanly when there are no open factory PRs', async () => {
      const res = await runMain('resume-approved');
      expect(res.exited).toBe(false);
      expect(errored()).toBe('');
    });

    it('exits 5 and reports failed PRs when landing an approved PR fails', async () => {
      h.octokit.graphql = vi.fn(async (query: string) => {
        if (query.includes('OpenFactoryPRs')) {
          return {
            repository: {
              pullRequests: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  { number: 12, headRefName: 'ship-it/5-fix-the-bug', reviewDecision: 'APPROVED', isDraft: false },
                ],
              },
            },
          };
        }
        return {};
      });
      h.octokit.rest.issues.get = vi.fn(async () => {
        throw new Error('issue vanished');
      });
      const res = await runMain('resume-approved');
      expect(res).toEqual({ exited: true, code: 5 });
      expect(logged()).toContain('failed to land');
      expect(errored()).toContain('1 PR(s) failed to land');
    });
  });

  describe('ship (via cmdShip)', () => {
    it('runs worktree gc before shipping when worktree.autoGcOnRun is true (#1756)', async () => {
      h.factoryConfig = { ...h.factoryConfig, worktree: { parent: '../', gcTtlDays: 7, autoGcOnRun: true } };
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).toHaveBeenCalledWith(
        expect.objectContaining({ repoRoot: h.repoRoot, ttlDays: 7, repo: h.ghRepo }),
        expect.objectContaining({ octokit: expect.anything() }),
      );
      expect(ops.formatGcReport).toHaveBeenCalled();
    });

    it('does not run worktree gc when worktree.autoGcOnRun is false (#1756)', async () => {
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).not.toHaveBeenCalled();
    });

    it('names the branch with the default factory prefix when --branch-prefix is omitted', async () => {
      const branches: string[] = [];
      h.setupWorktreeImpl = async (_r, branch) => {
        branches.push(branch);
      };
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(branches[0]).toEqual('factory/5-fix-the-bug');
    });

    it('names the branch and worktree with --branch-prefix sf', async () => {
      const calls: string[][] = [];
      h.setupWorktreeImpl = async (_r, branch, worktree) => {
        calls.push([branch, worktree]);
      };
      const res = await runMain('ship', '5', '--branch-prefix', 'sf');
      expect(res.exited).toBe(false);
      expect(calls[0][0]).toEqual('sf/5-fix-the-bug');
      expect(calls[0][1]).toContain('-factory-sf-');
    });

    it('exits 2 before any phase runs when --branch-prefix has no letters or digits', async () => {
      const res = await runMain('ship', '5', '--branch-prefix', '!!!');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('--branch-prefix');
      expect(phases.planPhase).not.toHaveBeenCalled();
    });
    it('ships an issue through all phases and prints the ready PR', async () => {
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('PR #99 ready for review');
    });

    // Regression (#681): a closed issue exits 0 (not 1) through the CLI command.
    it('exits 0 on a closed issue instead of failing', async () => {
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix the bug', state: 'closed' } }));
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('skipped:');
    });

    it('reports already-delivered instead of "ready for review" when SHIP recovery finds a prior merged PR (#520)', async () => {
      h.shipResult = { ok: true, prNumber: 518, alreadyDelivered: true };
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('already delivered by merged PR #518');
      expect(logged()).not.toContain('PR #518 ready for review');
    });

    it('reports the branch as already landed on main when SHIP recovery finds no merged PR for it (#520)', async () => {
      h.shipResult = { ok: true, alreadyDelivered: true };
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('already delivered — branch already landed on main');
      expect(logged()).not.toContain('PR #undefined');
    });

    it('prints a yellow SKIP line for a skipped checker while the run still succeeds', async () => {
      h.checkResult = {
        passed: true,
        summary: {
          results: [
            {
              checker: 'tests',
              result: 'SKIP',
              details: 'no verification command was run — no scripts/verify.sh and no package.json test script found',
            },
          ],
          failures: 0,
        },
        reworkRounds: 0,
      };
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(errored()).toContain('SKIP: tests');
    });

    it('exits 1 and logs a park event when a check fails', async () => {
      h.checkResult = {
        passed: false,
        summary: { results: [{ checker: 'lint', result: 'FAIL', details: 'bad' }], failures: 1 },
        reworkRounds: 2,
      };
      const res = await runMain('ship', '5');
      expect(res).toEqual({ exited: true, code: 1 });
      const events = readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const failEvents = events.filter((e: any) => e.type === 'fail' && e.issue === '5');
      expect(failEvents).toHaveLength(1);
      expect(errored()).toContain('Ship failed');
    });

    it('exits 1 and logs exactly one park event when a check fails under FACTORY_LOCAL_ONLY=1', async () => {
      trackEnv('FACTORY_LOCAL_ONLY');
      process.env.FACTORY_LOCAL_ONLY = '1';
      h.checkResult = {
        passed: false,
        summary: { results: [{ checker: 'lint', result: 'FAIL', details: 'bad' }], failures: 1 },
        reworkRounds: 2,
      };
      const res = await runMain('ship', '5');
      expect(res).toEqual({ exited: true, code: 1 });
      const events = readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const failEvents = events.filter((e: any) => e.type === 'fail' && e.issue === '5');
      expect(failEvents).toHaveLength(1);
      expect(errored()).toContain('Ship failed');
    });

    it('reaches shipPhase without an approval gate when --interactive is not passed', async () => {
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      const call = phases.shipPhase.mock.calls.at(-1)?.[0] as any;
      expect(call.approvalGate).toBeUndefined();
    });

    it('passes an approval gate to shipPhase when --interactive is set', async () => {
      const res = await runMain('ship', '5', '--interactive');
      expect(res.exited).toBe(false);
      const call = phases.shipPhase.mock.calls.at(-1)?.[0] as any;
      expect(typeof call.approvalGate).toBe('function');
    });

    it('reaches planPhase without an approval gate when --approve-plan is not passed', async () => {
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      const call = phases.planPhase.mock.calls.at(-1)?.[0] as any;
      expect(call.approvalGate).toBeUndefined();
      expect(call.enforceReadiness).toBe(true);
      expect(call?.enforceSizeGate).toBe(true);
      expect(call.drainSteering).toBeUndefined();
    });

    it('passes an approval gate and drainSteering to planPhase when --approve-plan is set', async () => {
      const res = await runMain('ship', '5', '--approve-plan');
      expect(res.exited).toBe(false);
      const call = phases.planPhase.mock.calls.at(-1)?.[0] as any;
      expect(typeof call.approvalGate).toBe('function');
      expect(typeof call.drainSteering).toBe('function');
    });

    it('passes the agent prerequisite with only the codex CLI on PATH (#1269)', async () => {
      coreFakes.isCommandAvailable.mockImplementation((c: string) => c === 'codex' || c === 'git' || c === 'gh');
      const res = await runMain('ship', '5');
      expect(errored()).not.toContain('no coding agent CLI');
      expect(errored()).not.toContain('claude CLI not found');
      expect(phases.planPhase).toHaveBeenCalled();
      expect(res.exited === false || res.code !== 2).toBe(true);
    });

    it('exits 2 with the missing-agent message and never invokes the phase mocks when no agent CLI is available', async () => {
      h.claudeAvailable = false;
      const res = await runMain('ship', '42');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('no coding agent CLI found on PATH');
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.buildPhase).not.toHaveBeenCalled();
      expect(phases.checkPhase).not.toHaveBeenCalled();
      expect(phases.shipPhase).not.toHaveBeenCalled();
    });

    it('exits 2 with the not-initialized message when .factory/ is missing', async () => {
      rmSync(paths().root, { recursive: true, force: true });
      const res = await runMain('ship', '5');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('factory not initialized — run `factory init` first');
    });

    it('parses --no-sandbox to opts.sandbox === false and logs sandbox disabled by the CLI flag', async () => {
      const res = await runMain('ship', '5', '--no-sandbox');
      expect(res.exited).toBe(false);
      expect(errored()).toContain('sandbox disabled by --no-sandbox — agent runs are UNCONTAINED');
      const events = readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.some((e: any) => e.type === 'sandbox-disabled' && e.msg.includes('--no-sandbox'))).toBe(true);
    });

    it('defaults --sandbox to true (no CLI-disabled event) when the flag is not passed', async () => {
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(errored()).not.toContain('sandbox disabled by --no-sandbox');
      const events = readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.some((e: any) => e.type === 'sandbox-disabled' && e.msg.includes('--no-sandbox'))).toBe(false);
    });

    it('warns that FACTORY_MERGE does not apply to ship and names factory land/run (#978)', async () => {
      process.env.FACTORY_MERGE = '1';
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(errored()).toContain('FACTORY_MERGE=1 ignored');
      expect(errored()).toContain('factory land 5');
      expect(errored()).toContain('factory run');
      expect(logged()).toContain('PR #99 ready for review');
    });

    it('records the ignored-merge notice as a warn event (#978)', async () => {
      process.env.FACTORY_MERGE = '1';
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      const events = readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const warnEvents = events.filter((e: any) => e.type === 'warn' && e.issue === '5' && e.msg.includes('ignored'));
      expect(warnEvents).toHaveLength(1);
    });

    it('warns for FACTORY_MERGE_ADMIN alone (#978)', async () => {
      process.env.FACTORY_MERGE_ADMIN = '1';
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(errored()).toContain('FACTORY_MERGE_ADMIN=1 ignored');
    });

    it('prints no merge notice when neither variable is set (#978)', async () => {
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(errored()).not.toContain('ignored —');
      const events = readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.some((e: any) => e.type === 'warn' && e.msg.includes('ignored'))).toBe(false);
    });
  });

  describe('run-issue (one-shot)', () => {
    it.each(['ship', 'run-issue'])(
      '%s refuses a pull request number before any model or plan call (#2492)',
      async (cmd) => {
        h.octokit.rest.issues.get = vi.fn(async () => ({
          data: { title: 'Add subtract (#1)', body: 'Closes #1', pull_request: { url: 'x' } },
        }));
        const routerRun = vi.fn(h.routerRun);
        h.routerRun = routerRun;
        const res = await runMain(cmd, '2');
        expect(res).toEqual({ exited: true, code: 2 });
        expect(errored()).toContain('#2 is a pull request, not an issue. Did you mean issue #1?');
        expect(phases.planPhase).not.toHaveBeenCalled();
        expect(routerRun).not.toHaveBeenCalled();
      },
    );

    it('runs worktree gc before shipping when worktree.autoGcOnRun is true (#1756)', async () => {
      h.factoryConfig = { ...h.factoryConfig, worktree: { parent: '../', gcTtlDays: 7, autoGcOnRun: true } };
      const res = await runMain('run-issue', '5');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).toHaveBeenCalledWith(
        expect.objectContaining({ repoRoot: h.repoRoot, ttlDays: 7, repo: h.ghRepo }),
        expect.objectContaining({ octokit: expect.anything() }),
      );
      expect(ops.formatGcReport).toHaveBeenCalled();
    });

    it('does not run worktree gc when worktree.autoGcOnRun is false (#1756)', async () => {
      const res = await runMain('run-issue', '5');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).not.toHaveBeenCalled();
    });

    describe('--size-gate (#2048)', () => {
      const enforced = () => phases.planPhase.mock.calls.at(-1)?.[0].enforceSizeGate;

      it('enforces the size gates with no config and no flag', async () => {
        await runMain('run-issue', '5');
        expect(enforced()).toBe(true);
      });

      it('skips the size gates when sizeGate.mode is off in the config', async () => {
        h.factoryConfig = { ...h.factoryConfig, sizeGate: { mode: 'off' } };
        await runMain('run-issue', '5');
        expect(enforced()).toBe(false);
      });

      it('--size-gate off beats a file config', async () => {
        h.factoryConfig = { ...h.factoryConfig, sizeGate: { mode: 'file' } };
        await runMain('run-issue', '5', '--size-gate', 'off');
        expect(enforced()).toBe(false);
      });

      it('--size-gate file beats an off config', async () => {
        h.factoryConfig = { ...h.factoryConfig, sizeGate: { mode: 'off' } };
        await runMain('run-issue', '5', '--size-gate', 'file');
        expect(enforced()).toBe(true);
      });

      it('--size-gate slice passes sizeGateMode slice to planPhase', async () => {
        await runMain('run-issue', '5', '--size-gate', 'slice');
        expect(phases.planPhase.mock.calls.at(-1)?.[0].sizeGateMode).toBe('slice');
      });

      it('sizeGate.mode slice in the config passes sizeGateMode slice to planPhase', async () => {
        h.factoryConfig = { ...h.factoryConfig, sizeGate: { mode: 'slice' } };
        await runMain('run-issue', '5');
        expect(phases.planPhase.mock.calls.at(-1)?.[0].sizeGateMode).toBe('slice');
      });

      it('--size-gate stack passes sizeGateMode stack to planPhase', async () => {
        await runMain('run-issue', '5', '--size-gate', 'stack');
        const call = phases.planPhase.mock.calls.at(-1)?.[0];
        expect(call?.sizeGateMode).toBe('stack');
        expect(call?.enforceSizeGate).toBe(true);
      });

      it('sizeGate.mode stack in the config passes sizeGateMode stack to planPhase', async () => {
        h.factoryConfig = { ...h.factoryConfig, sizeGate: { mode: 'stack' } };
        await runMain('run-issue', '5');
        expect(phases.planPhase.mock.calls.at(-1)?.[0].sizeGateMode).toBe('stack');
      });

      it('--max-slices 6 passes maxSlices 6 to planPhase (ADR-0156)', async () => {
        await runMain('run-issue', '5', '--size-gate', 'slice', '--max-slices', '6');
        expect(phases.planPhase.mock.calls.at(-1)?.[0].maxSlices).toBe(6);
      });

      it('sizeGate.maxSlices in the config is used when the flag is absent', async () => {
        h.factoryConfig = { ...h.factoryConfig, sizeGate: { mode: 'slice', maxSlices: 7 } };
        await runMain('run-issue', '5');
        expect(phases.planPhase.mock.calls.at(-1)?.[0].maxSlices).toBe(7);
      });

      it('defaults maxSlices to 10 with neither flag nor config', async () => {
        await runMain('run-issue', '5');
        expect(phases.planPhase.mock.calls.at(-1)?.[0].maxSlices).toBe(10);
      });

      it.each(['0', '21', '2.5', 'abc', ''])('rejects --max-slices %j with exit 2 before planning', async (value) => {
        const res = await runMain('run-issue', '5', '--max-slices', value);
        expect(res).toMatchObject({ exited: true, code: 2 });
        expect(errored()).toContain('--max-slices');
        expect(phases.planPhase).not.toHaveBeenCalled();
      });

      it('rejects an unknown mode with exit 2 before planning', async () => {
        const res = await runMain('run-issue', '5', '--size-gate', 'bogus');
        expect(res).toMatchObject({ exited: true, code: 2 });
        expect(errored()).toContain('--size-gate');
        expect(errored()).toContain('file');
        expect(errored()).toContain('off');
        expect(phases.planPhase).not.toHaveBeenCalled();
      });

      it('--help lists --size-gate', async () => {
        const originalWrite = process.stdout.write;
        const written: string[] = [];
        process.stdout.write = ((chunk: string | Uint8Array) => {
          written.push(String(chunk));
          return true;
        }) as typeof process.stdout.write;
        try {
          await runMain('run-issue', '--help');
        } finally {
          process.stdout.write = originalWrite;
        }
        expect(written.join('')).toContain('--size-gate');
        expect(written.join('')).toContain('slice');
      });
    });

    it('--help lists --run-children with its one-line description (#1750)', async () => {
      const originalWrite = process.stdout.write;
      const written: string[] = [];
      process.stdout.write = ((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      let res: Awaited<ReturnType<typeof runMain>>;
      try {
        res = await runMain('run-issue', '--help');
      } finally {
        process.stdout.write = originalWrite;
      }
      expect(res.exited).toBe(true);
      const text = written.join('').replace(/\s+/g, ' ');
      expect(text).toContain('--run-children');
      expect(text).toContain('File mode only: when the size gate files child issues, run them');
    });

    it('names the branch with the default factory prefix when --branch-prefix is omitted', async () => {
      const branches: string[] = [];
      h.setupWorktreeImpl = async (_r, branch) => {
        branches.push(branch);
      };
      const res = await runMain('run-issue', '5');
      expect(res.exited).toBe(false);
      expect(branches[0]).toEqual('factory/5-fix-the-bug');
    });

    it('names the branch and worktree with --branch-prefix sf', async () => {
      const calls: string[][] = [];
      h.setupWorktreeImpl = async (_r, branch, worktree) => {
        calls.push([branch, worktree]);
      };
      const res = await runMain('run-issue', '5', '--branch-prefix', 'sf');
      expect(res.exited).toBe(false);
      expect(calls[0][0]).toEqual('sf/5-fix-the-bug');
      expect(calls[0][1]).toContain('-factory-sf-');
    });
    it('names the child issues and suggests --run-children when the size gate decomposes the issue', async () => {
      h.planResult = { ok: false, route: 'claude', escalate: 'decomposed', decomposed: { childIssues: [10, 11] } };
      const res = await runMain('run-issue', '5');
      expect(res).toMatchObject({ exited: true, code: 1 });
      expect(errored()).toContain('#10');
      expect(errored()).toContain('#11');
      expect(errored()).toContain('--run-children');
      expect(phases.planPhase).toHaveBeenCalledTimes(1);
      expect(phases.buildPhase).not.toHaveBeenCalled();
      expect(phases.shipPhase).not.toHaveBeenCalled();
    });

    it('accepts --run-children and ships a non-decomposed issue exactly as without it', async () => {
      const res = await runMain('run-issue', '5', '--run-children');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('PR #99 ready for review');
      expect(phases.planPhase).toHaveBeenCalledTimes(1);
      expect(phases.buildPhase).toHaveBeenCalledTimes(1);
      expect(phases.checkPhase).toHaveBeenCalledTimes(1);
      expect(phases.shipPhase).toHaveBeenCalledTimes(1);
    });

    describe('--run-children', () => {
      const decompose = (children: number[]) =>
        ({ ok: false, route: 'claude', escalate: 'decomposed', decomposed: { childIssues: children } }) as any;

      it('runs children in order, prints the summary, takes no labels/merge, and holds the lock', async () => {
        const { existsSync } = await import('node:fs');
        const lockPath = join(paths().state, 'run.lock');
        writeFileSync(paths().queue, 'app 7\n');
        const lockSeen: boolean[] = [];
        const recordLock = async () => {
          lockSeen.push(existsSync(lockPath));
          return h.planResult;
        };
        phases.planPhase
          .mockImplementationOnce(async () => decompose([10, 11]))
          .mockImplementationOnce(recordLock)
          .mockImplementationOnce(recordLock);
        phases.shipPhase
          .mockResolvedValueOnce({ ok: true, prNumber: 101 } as any)
          .mockResolvedValueOnce({ ok: true, prNumber: 102 } as any);
        h.octokit.rest.issues.addLabels = vi.fn(async () => ({}));

        const res = await runMain('run-issue', '5', '--run-children');

        expect(res.exited).toBe(false);
        const issues = h.octokit.rest.issues.get.mock.calls.map((c: any[]) => c[0].issue_number);
        expect(issues.slice(0, 3)).toEqual([5, 10, 11]);
        expect(phases.planPhase).toHaveBeenCalledTimes(3);
        expect(phases.buildPhase).toHaveBeenCalledTimes(2);
        expect(phases.checkPhase).toHaveBeenCalledTimes(2);
        expect(phases.shipPhase).toHaveBeenCalledTimes(2);
        expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
        expect(h.octokit.rest.pulls.merge).not.toHaveBeenCalled();
        expect(readFileSync(paths().queue, 'utf-8')).toBe('app 7\n');
        expect(logged()).toContain('#10 → PR #101 ready for review');
        expect(logged()).toContain('#11 → PR #102 ready for review');
        expect(logged()).toContain('2/2 children ready for review');
        expect(lockSeen).toEqual([true, true]);
        expect(existsSync(lockPath)).toBe(false);
      });

      it('continues past a failed child and exits 1', async () => {
        phases.planPhase.mockImplementationOnce(async () => decompose([10, 11, 12]));
        phases.shipPhase
          .mockResolvedValueOnce({ ok: true, prNumber: 101 } as any)
          .mockResolvedValueOnce({ ok: false } as any)
          .mockResolvedValueOnce({ ok: true, prNumber: 112 } as any);
        const res = await runMain('run-issue', '5', '--run-children');
        expect(res).toMatchObject({ exited: true, code: 1 });
        expect(logged()).toContain('#11 → failed');
        expect(logged()).toContain('#12 → PR #112 ready for review');
        expect(logged()).toContain('2/3 children ready for review');
        expect(phases.planPhase).toHaveBeenCalledTimes(4);
      });

      it('an escalated child does not stop later children', async () => {
        phases.planPhase
          .mockImplementationOnce(async () => decompose([10, 11]))
          .mockImplementationOnce(async () => ({ ok: false, route: 'claude', escalate: 'needs human' }) as any);
        phases.shipPhase.mockResolvedValueOnce({ ok: true, prNumber: 111 } as any);
        const res = await runMain('run-issue', '5', '--run-children');
        expect(res).toMatchObject({ exited: true, code: 1 });
        expect(logged()).toContain('#10 → failed');
        expect(logged()).toContain('#11 → PR #111 ready for review');
      });

      it('stops starting children once .factory/STOP appears, and leaves STOP in place', async () => {
        const stopPath = join(paths().state, 'STOP');
        phases.planPhase.mockImplementationOnce(async () => decompose([10, 11]));
        phases.shipPhase.mockImplementationOnce(async () => {
          writeFileSync(stopPath, '');
          return { ok: true, prNumber: 110 } as any;
        });
        const res = await runMain('run-issue', '5', '--run-children');
        expect(res).toMatchObject({ exited: true, code: 1 });
        expect(phases.shipPhase).toHaveBeenCalledTimes(1);
        expect(phases.planPhase).toHaveBeenCalledTimes(2);
        expect(logged()).toContain('#10 → PR #110 ready for review');
        expect(logged()).toContain('#11 → not run: .factory/STOP present');
        expect(readFileSync(stopPath, 'utf-8')).toBe('');
      });

      it('runs a nested decomposition in place of the child, before later siblings', async () => {
        phases.planPhase
          .mockImplementationOnce(async () => decompose([10, 11]))
          .mockImplementationOnce(async () => decompose([20, 21]));
        phases.shipPhase
          .mockResolvedValueOnce({ ok: true, prNumber: 120 } as any)
          .mockResolvedValueOnce({ ok: true, prNumber: 121 } as any)
          .mockResolvedValueOnce({ ok: true, prNumber: 111 } as any);
        const res = await runMain('run-issue', '5', '--run-children');
        expect(res.exited).toBe(false);
        const issues = h.octokit.rest.issues.get.mock.calls.map((c: any[]) => c[0].issue_number);
        expect(issues.slice(0, 5)).toEqual([5, 10, 20, 21, 11]);
        expect(phases.planPhase).toHaveBeenCalledTimes(5);
        expect(phases.shipPhase).toHaveBeenCalledTimes(3);
        expect(logged()).toContain('#10 → decomposed into #20, #21');
        expect(logged()).toContain('3/3 children ready for review');
      });

      const closeIssue10 = () => {
        const get = h.octokit.rest.issues.get;
        h.octokit.rest.issues.get = vi.fn(async (args: any) => {
          const res = await get(args);
          return args.issue_number === 10 ? { ...res, data: { ...res.data, state: 'closed' } } : res;
        });
      };

      it('skips a closed child, keeps going, and exits 0', async () => {
        phases.planPhase.mockImplementationOnce(async () => decompose([10, 11]));
        phases.shipPhase.mockResolvedValueOnce({ ok: true, prNumber: 111 } as any);
        closeIssue10();
        const res = await runMain('run-issue', '5', '--run-children');
        expect(res.exited).toBe(false);
        expect(phases.shipPhase).toHaveBeenCalledTimes(1);
        expect(logged()).toContain('#10 → skipped:');
        expect(logged()).toContain('#11 → PR #111 ready for review');
        expect(logged()).toContain('1/2 children ready for review, 1 skipped');
      });

      it('still exits 1 when a child after a skipped one fails', async () => {
        phases.planPhase.mockImplementationOnce(async () => decompose([10, 11]));
        phases.shipPhase.mockResolvedValueOnce({ ok: false } as any);
        closeIssue10();
        const res = await runMain('run-issue', '5', '--run-children');
        expect(res).toMatchObject({ exited: true, code: 1 });
        expect(logged()).toContain('#10 → skipped:');
        expect(logged()).toContain('#11 → failed');
      });

      it('records a child that cannot be resolved as failed', async () => {
        phases.planPhase.mockImplementationOnce(async () => decompose([10]));
        const get = h.octokit.rest.issues.get;
        h.octokit.rest.issues.get = vi.fn(async (args: any) => {
          if (args.issue_number === 10) throw new Error('Not Found');
          return get(args);
        });
        const res = await runMain('run-issue', '5', '--run-children');
        expect(res).toMatchObject({ exited: true, code: 1 });
        expect(logged()).toContain('could not resolve issue #10');
      });
    });

    it('resolves the issue through the canonical work-request seam and ships it through all phases', async () => {
      const res = await runMain('run-issue', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('PR #99 ready for review');
      expect(logged()).toContain(`github-issue:${h.ghRepo}#5`);
      expect(phases.planPhase).toHaveBeenCalledTimes(1);
      expect(phases.buildPhase).toHaveBeenCalledTimes(1);
      expect(phases.checkPhase).toHaveBeenCalledTimes(1);
      expect(phases.shipPhase).toHaveBeenCalledTimes(1);
      expect(h.octokit.rest.issues.get).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 5 }));
    });

    // Regression (#681): a closed issue exits 0 (not 1) through the CLI command,
    // reusing the ctx.workRequest resolved by this command's own preflight.
    it('exits 0 on a closed issue instead of failing', async () => {
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix the bug', state: 'closed' } }));
      const res = await runMain('run-issue', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('skipped:');
      expect(h.octokit.rest.issues.get).toHaveBeenCalledTimes(1);
    });

    it('leaves the queue file untouched', async () => {
      writeFileSync(paths().queue, 'app 7\ndocs 9\n');
      const res = await runMain('run-issue', '5');
      expect(res.exited).toBe(false);
      expect(readFileSync(paths().queue, 'utf-8')).toBe('app 7\ndocs 9\n');
    });

    it('rejects a non-numeric identifier before any work', async () => {
      const res = await runMain('run-issue', 'abc');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('invalid issue argument');
      expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.shipPhase).not.toHaveBeenCalled();
      expect(h.octokit.rest.issues.get).not.toHaveBeenCalled();
    });

    it('rejects a zero identifier before any work', async () => {
      const res = await runMain('run-issue', '0');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('invalid issue argument');
    });

    it('fails pre-flight with exit 2 when the issue is unreachable — no worktree, no PR', async () => {
      h.octokit.rest.issues.get = vi.fn(async () => {
        throw new Error('Not Found');
      });
      const res = await runMain('run-issue', '5');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('could not resolve issue #5');
      expect(errored()).toContain('no worktree or PR was created');
      expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.shipPhase).not.toHaveBeenCalled();
    });

    it('maps a pipeline failure to exit 1, not a pre-flight error', async () => {
      h.checkResult = {
        passed: false,
        summary: { results: [{ checker: 'lint', result: 'FAIL', details: 'bad' }], failures: 1 },
        reworkRounds: 2,
      };
      const res = await runMain('run-issue', '5');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('Run failed for issue #5');
    });

    it('exits 2 with the missing-agent message and never invokes the phase mocks when no agent CLI is available', async () => {
      h.claudeAvailable = false;
      const res = await runMain('run-issue', '5');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('no coding agent CLI found on PATH');
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.buildPhase).not.toHaveBeenCalled();
      expect(phases.checkPhase).not.toHaveBeenCalled();
      expect(phases.shipPhase).not.toHaveBeenCalled();
    });

    it('exits 2 with the not-initialized message when .factory/ is missing', async () => {
      rmSync(paths().root, { recursive: true, force: true });
      const res = await runMain('run-issue', '5');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('factory not initialized — run `factory init` first');
    });

    it('reports invalid work-request input as a pre-flight error, not a generic resolve failure', async () => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return 'not-a-valid-repo-slug';
        return '';
      };
      const res = await runMain('run-issue', '5');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('invalid input for work-request source');
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.shipPhase).not.toHaveBeenCalled();
    });

    it('logs a human-restarted event when a prior run for the issue was parked', async () => {
      writeFileSync(
        paths().events,
        [
          JSON.stringify({ ts: '2026-07-01T00:00:00.000Z', type: 'fail', issue: '5', msg: 'checker failures' }),
          '',
        ].join('\n'),
      );
      const res = await runMain('run-issue', '5');
      expect(res.exited).toBe(false);
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('human-restarted');
      expect(events).toContain('manual retry of a previously parked/failed run');
    });
  });

  describe('run-brief (one-shot)', () => {
    const VALID_BRIEF = `# Add a widget

Please add a widget that does the thing.

## Acceptance criteria

- the widget exists
`;

    function writeBrief(content = VALID_BRIEF): string {
      const briefPath = join(h.repoRoot, 'brief.md');
      writeFileSync(briefPath, content);
      return briefPath;
    }

    function readEventLines(): any[] {
      return readFileSync(paths().events, 'utf-8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    }

    const workspaceDirs: string[] = [];

    function writeWorkspace(): string {
      const ws = mkdtempSync(join(tmpdir(), 'factory-ws-'));
      mkdirSync(join(ws, '.git'));
      workspaceDirs.push(ws);
      return ws;
    }

    it.each([
      [[], /^factory\//, false],
      [['--branch-prefix', 'sf'], /^sf\//, true],
    ] as const)('creates the worktree branch for prefix args %j', async (extra, pattern, sf) => {
      const calls: string[][] = [];
      h.setupWorktreeImpl = async (_r, branch, worktree) => {
        calls.push([branch, worktree]);
      };
      const res = await runMain('run-brief', writeBrief(), ...extra);
      expect(res.exited).toBe(false);
      expect(calls[0][0]).toMatch(pattern);
      if (sf) expect(calls[0][1]).toContain('-factory-sf-');
    });

    afterEach(() => {
      for (const ws of workspaceDirs.splice(0)) rmSync(ws, { recursive: true, force: true });
    });

    it('resolves the brief through the canonical work-request seam and ships it through all phases', async () => {
      const briefPath = writeBrief();
      const digest = createHash('sha256').update(VALID_BRIEF).digest('hex');

      const res = await runMain('run-brief', briefPath);

      expect(res.exited).toBe(false);
      expect(logged()).toContain('PR #99 ready for review');
      expect(logged()).toContain('local-brief:');
      expect(phases.planPhase).toHaveBeenCalledTimes(1);
      expect(phases.buildPhase).toHaveBeenCalledTimes(1);
      expect(phases.checkPhase).toHaveBeenCalledTimes(1);
      expect(phases.shipPhase).toHaveBeenCalledTimes(1);
      expect(h.octokit.rest.issues.get).not.toHaveBeenCalled();
      expect(vi.mocked(setupWorktree)).toHaveBeenCalled();

      const planArgs = phases.planPhase.mock.calls.at(-1)?.[0] as any;
      expect(planArgs.workSource).toEqual({ kind: 'local-brief', params: { path: briefPath } });

      const buildArgs = phases.buildPhase.mock.calls.at(-1)?.[0] as any;
      expect(buildArgs.disablePublish).toBeFalsy();

      const shipArgs = phases.shipPhase.mock.calls.at(-1)?.[0] as any;
      expect(shipArgs.work).toMatchObject({ kind: 'local-brief' });

      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('inline local brief');
      expect(events).toContain(digest);

      const workSourceEvent = readEventLines().find((e) => e.type === 'work-source');
      expect(workSourceEvent.issue).toMatch(/^9\d{6}$/);
    });

    it('leaves the queue file untouched', async () => {
      writeFileSync(paths().queue, 'app 7\ndocs 9\n');
      const briefPath = writeBrief();

      const res = await runMain('run-brief', briefPath);

      expect(res.exited).toBe(false);
      expect(readFileSync(paths().queue, 'utf-8')).toBe('app 7\ndocs 9\n');
    });

    it('fails pre-flight with exit 2 on a malformed brief — no worktree, no BUILD', async () => {
      const briefPath = writeBrief('# Add a widget\n\nPlease add a widget that does the thing.\n');

      const res = await runMain('run-brief', briefPath);

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('no acceptance criteria');
      expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.buildPhase).not.toHaveBeenCalled();
    });

    it('fails pre-flight with exit 2 when the brief file is missing — no worktree, no PR', async () => {
      const briefPath = join(h.repoRoot, 'does-not-exist.md');

      const res = await runMain('run-brief', briefPath);

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('could not resolve brief');
      expect(errored()).toContain('no worktree or PR was created');
      expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
      expect(phases.planPhase).not.toHaveBeenCalled();
    });

    it('exits 2 with the missing-agent message and never invokes the phase mocks when no agent CLI is available', async () => {
      h.claudeAvailable = false;
      const briefPath = writeBrief();

      const res = await runMain('run-brief', briefPath);

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('no coding agent CLI found on PATH');
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.buildPhase).not.toHaveBeenCalled();
      expect(phases.checkPhase).not.toHaveBeenCalled();
      expect(phases.shipPhase).not.toHaveBeenCalled();
    });

    it('exits 2 with the not-initialized message when .factory/ is missing', async () => {
      rmSync(paths().root, { recursive: true, force: true });
      const briefPath = writeBrief();

      const res = await runMain('run-brief', briefPath);

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('factory not initialized — run `factory init` first');
    });

    it('maps a pipeline failure to exit 1, not a pre-flight error', async () => {
      h.checkResult = {
        passed: false,
        summary: { results: [{ checker: 'lint', result: 'FAIL', details: 'bad' }], failures: 1 },
        reworkRounds: 2,
      };
      const briefPath = writeBrief();

      const res = await runMain('run-brief', briefPath);

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('Run failed for brief');
    });

    it('logs a human-restarted event when a prior run for the digest-derived run number was parked', async () => {
      const briefPath = writeBrief();
      const digest = createHash('sha256').update(VALID_BRIEF).digest('hex');
      const runNum = 9_000_000 + (Number.parseInt(digest.slice(0, 8), 16) % 1_000_000);
      writeFileSync(
        paths().events,
        [
          JSON.stringify({
            ts: '2026-07-01T00:00:00.000Z',
            type: 'fail',
            issue: String(runNum),
            msg: 'checker failures',
          }),
          '',
        ].join('\n'),
      );

      const res = await runMain('run-brief', briefPath);

      expect(res.exited).toBe(false);
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('human-restarted');
      expect(events).toContain('manual retry of a previously parked/failed run');
    });

    describe('--workspace (local-only)', () => {
      it('runs PLAN/BUILD/CHECK in the caller workspace, disables publish, and skips SHIP', async () => {
        const ws = writeWorkspace();
        const briefPath = writeBrief();

        const res = await runMain('run-brief', briefPath, '--workspace', ws);

        expect(res.exited).toBe(false);
        expect(logged()).toContain('Local-only run complete');
        expect(logged()).toContain('publishing disabled');
        expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
        expect(phases.shipPhase).not.toHaveBeenCalled();

        expect(phases.planPhase).toHaveBeenCalledTimes(1);
        expect(phases.buildPhase).toHaveBeenCalledTimes(1);
        expect(phases.checkPhase).toHaveBeenCalledTimes(1);
        expect(phases.planPhase.mock.calls.at(-1)?.[0]).toMatchObject({ worktree: ws });
        expect(phases.buildPhase.mock.calls.at(-1)?.[0]).toMatchObject({
          worktree: ws,
          disablePublish: true,
        });
        expect(phases.checkPhase.mock.calls.at(-1)?.[0]).toMatchObject({ worktree: ws });

        expect(h.octokit.rest.issues.get).not.toHaveBeenCalled();

        const events = readFileSync(paths().events, 'utf-8');
        expect(events).toContain('local-only');
        expect(events).toContain(ws);
      });

      it('needs no GitHub remote — getGitHubRepo is never called', async () => {
        const ws = writeWorkspace();
        const briefPath = writeBrief();
        h.execImpl = (cmd: string) => {
          if (cmd.includes('rev-parse')) return h.repoRoot;
          if (cmd.includes('gh repo view')) throw new Error('no GitHub remote configured');
          return '';
        };

        const res = await runMain('run-brief', briefPath, '--workspace', ws);

        expect(res.exited).toBe(false);
        expect(logged()).toContain('Local-only run complete');
      });

      it('leaves the queue file byte-identical', async () => {
        writeFileSync(paths().queue, 'app 7\ndocs 9\n');
        const ws = writeWorkspace();
        const briefPath = writeBrief();

        const res = await runMain('run-brief', briefPath, '--workspace', ws);

        expect(res.exited).toBe(false);
        expect(readFileSync(paths().queue, 'utf-8')).toBe('app 7\ndocs 9\n');
      });

      it('exits 2 before any pipeline call when the workspace is missing', async () => {
        const missing = join(tmpdir(), 'factory-ws-does-not-exist-xyz');
        const briefPath = writeBrief();

        const res = await runMain('run-brief', briefPath, '--workspace', missing);

        expect(res).toEqual({ exited: true, code: 2 });
        expect(errored()).toContain('invalid local-only workspace');
        expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
        expect(phases.planPhase).not.toHaveBeenCalled();
        expect(phases.buildPhase).not.toHaveBeenCalled();
      });

      it('exits 2 before any pipeline call when the workspace has no .git', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'factory-ws-'));
        workspaceDirs.push(ws);
        const briefPath = writeBrief();

        const res = await runMain('run-brief', briefPath, '--workspace', ws);

        expect(res).toEqual({ exited: true, code: 2 });
        expect(errored()).toContain('not an initialized git repository');
        expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
        expect(phases.planPhase).not.toHaveBeenCalled();
      });
    });

    describe('--artifacts (benchmark manifest)', () => {
      const artifactsDirs: string[] = [];

      function writeArtifactsDir(): string {
        const dir = mkdtempSync(join(tmpdir(), 'factory-artifacts-'));
        artifactsDirs.push(dir);
        return dir;
      }

      afterEach(() => {
        for (const dir of artifactsDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
      });

      it('writes a versioned manifest plus request/events/diff artifacts on a successful run', async () => {
        const ws = writeWorkspace();
        const artDir = writeArtifactsDir();
        const briefPath = writeBrief();

        const res = await runMain('run-brief', briefPath, '--workspace', ws, '--artifacts', artDir);

        expect(res.exited).toBe(false);
        expect(logged()).toContain('benchmark artifacts:');

        const manifestPath = join(artDir, 'manifest.json');
        expect(existsSync(manifestPath)).toBe(true);
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        expect(manifest.manifestVersion).toBe(1);
        expect(manifest.run.outcome).toBe('ready');
        expect(manifest.request.kind).toBe('local-brief');
        expect(manifest.phases.ship).toBe('skipped');

        expect(existsSync(join(artDir, 'request.json'))).toBe(true);
        expect(existsSync(join(artDir, 'events.ndjson'))).toBe(true);
        expect(existsSync(join(artDir, 'diff.patch'))).toBe(true);
      });

      it('writes a diagnosable manifest with a typed failure when CHECK fails', async () => {
        h.checkResult = {
          passed: false,
          summary: {
            failures: 1,
            passes: 0,
            skips: 0,
            total: 1,
            results: [{ checker: 'tests', result: 'FAIL', details: 'boom' }],
          },
          reworkRounds: 1,
        };
        const ws = writeWorkspace();
        const artDir = writeArtifactsDir();
        const briefPath = writeBrief();

        const res = await runMain('run-brief', briefPath, '--workspace', ws, '--artifacts', artDir);

        expect(res).toEqual({ exited: true, code: 1 });
        const manifestPath = join(artDir, 'manifest.json');
        expect(existsSync(manifestPath)).toBe(true);
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        expect(manifest.run.outcome).toBe('failed');
        expect(manifest.failure).toMatchObject({ phase: 'check', reason: 'fail' });
        expect(manifest.artifacts.events).toBe('events.ndjson');
      });

      it('exits 2 with --artifacts requires --workspace when --workspace is absent', async () => {
        const artDir = writeArtifactsDir();
        const briefPath = writeBrief();

        const res = await runMain('run-brief', briefPath, '--artifacts', artDir);

        expect(res).toEqual({ exited: true, code: 2 });
        expect(errored()).toContain('--artifacts requires --workspace');
        expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
        expect(phases.planPhase).not.toHaveBeenCalled();
      });

      it('exits 2 with invalid artifacts directory when the path is a regular file', async () => {
        const ws = writeWorkspace();
        const briefPath = writeBrief();
        const notADir = join(h.repoRoot, 'artifacts-file');
        writeFileSync(notADir, 'hello');

        const res = await runMain('run-brief', briefPath, '--workspace', ws, '--artifacts', notADir);

        expect(res).toEqual({ exited: true, code: 2 });
        expect(errored()).toContain('invalid artifacts directory');
        expect(phases.planPhase).not.toHaveBeenCalled();
      });

      it('writes no manifest for normal runs (no --artifacts)', async () => {
        const briefPathA = writeBrief();
        const resA = await runMain('run-brief', briefPathA);
        expect(resA.exited).toBe(false);
        expect(logged()).not.toContain('benchmark artifacts:');

        const ws = writeWorkspace();
        const briefPathB = writeBrief();
        const resB = await runMain('run-brief', briefPathB, '--workspace', ws);
        expect(resB.exited).toBe(false);
        expect(logged()).not.toContain('benchmark artifacts:');
      });
    });
  });

  describe('git/github detection failures', () => {
    it('exits 2 with "not inside a git repository" when git rev-parse fails', async () => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) throw new Error('fatal: not a git repository');
        return '';
      };
      const res = await runMain('status');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('not inside a git repository');
    });

    it('falls back to `gh auth token` via execSync when no GITHUB_TOKEN/GH_TOKEN env var is set', async () => {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      h.factoryConfig = { ...h.factoryConfig, filing: { selfFixLabel: 'no-auto-merge', enabled: false } };
      h.execSyncImpl = (cmd: string) => {
        if (cmd.includes('gh auth token')) return 'gho_fallback_token\n';
        throw new Error('not stubbed');
      };
      const res = await runMain('land', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('Landed PR #77');
    });
  });
});

// ===========================================================================
describe('CliExitError (direct command invocation)', () => {
  it('is a proper Error subclass carrying a code', () => {
    const err = new CliExitError('msg', 3);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CliExitError');
    expect(err.message).toBe('msg');
    expect(err.code).toBe(3);
  });

  it('cmdConstitution({}) rejects with code 2 and the usage message', async () => {
    await expect(cmdConstitution({}, coreFakes)).rejects.toMatchObject({
      name: 'CliExitError',
      code: 2,
      message: expect.stringContaining('usage: factory constitution'),
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("cmdConstitution({ product: 'nope' }) rejects with code 1 and the not-found message", async () => {
    await expect(cmdConstitution({ product: 'nope' }, coreFakes)).rejects.toMatchObject({
      name: 'CliExitError',
      code: 1,
      message: expect.stringContaining("No constitution 'nope'"),
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('cmdUsage() rejects with code 2 when FACTORY_USAGE_CAP is invalid', async () => {
    trackEnv('FACTORY_USAGE_CAP');
    process.env.FACTORY_USAGE_CAP = '-5';
    await expect(cmdUsage(coreFakes)).rejects.toMatchObject({
      name: 'CliExitError',
      code: 2,
      message: expect.stringContaining('FACTORY_USAGE_CAP'),
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('cmdUsage() prints the real subscription usage plus the heuristic comparison when the subscription signal is available', async () => {
    h.subscriptionUsage = { fiveHourUtilization: 42, fiveHourResetsAt: '2026-07-15T18:00:00Z' };
    await cmdUsage(coreFakes);
    const logged = logSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(logged).toContain('5h subscription usage: 42% of plan limit, resets 2026-07-15T18:00:00Z');
    expect(logged).toContain('heuristic list-price estimate: USAGE REPORT');
  });

  it('cmdUsage() falls back to the heuristic with a warning when the subscription signal is unavailable', async () => {
    h.subscriptionUsage = null;
    await cmdUsage(coreFakes);
    const logged = logSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(logged).toContain('real subscription usage unavailable');
    expect(logged).toContain('USAGE REPORT');
  });
});

// ===========================================================================
describe('parseIssueArg', () => {
  it('returns the parsed number for a valid issue argument', () => {
    expect(parseIssueArg('123')).toBe(123);
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseIssueArg(' 42 ')).toBe(42);
  });

  it.each(['abc', '', '12abc', '1.5', '-3', '0', '#123'])(
    "throws CliExitError(2) naming the invalid argument for '%s'",
    (raw) => {
      expect(() => parseIssueArg(raw)).toThrowError(CliExitError);
      try {
        parseIssueArg(raw);
        expect.fail('expected parseIssueArg to throw');
      } catch (err) {
        expect(err).toMatchObject({
          name: 'CliExitError',
          code: 2,
          message: expect.stringContaining(`'${raw}'`),
        });
      }
    },
  );
});

// ===========================================================================
describe('parseIssueArg wired into ship/land/local-small-dry-run', () => {
  it.each(['ship', 'land', 'local-small-dry-run'])(
    "'%s abc' fails before any GitHub or git work runs",
    async (command) => {
      const res = await runMain(command, 'abc');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain("invalid issue argument 'abc'");
      expect(h.octokit.rest.issues.get).not.toHaveBeenCalled();
      expect(h.octokit.rest.pulls.list).not.toHaveBeenCalled();
    },
  );
});

// ===========================================================================
describe('factory --help layout', () => {
  async function topLevelHelp(): Promise<string> {
    const originalWrite = process.stdout.write.bind(process.stdout);
    const written: string[] = [];
    process.stdout.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const res = await runMain('--help');
      expect(res.exited).toBe(true);
    } finally {
      process.stdout.write = originalWrite;
    }
    return written.join('');
  }

  /** Command names listed under one heading, up to the next blank line. */
  function section(help: string, heading: string): string[] {
    const start = help.indexOf(`${heading}\n`);
    expect(start, `missing heading ${heading}`).toBeGreaterThanOrEqual(0);
    const body = help.slice(start + heading.length + 1).split('\n\n')[0];
    return body
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0].split('|')[0])
      .filter((name) => /^[a-z]/.test(name));
  }

  it('shows every group heading in table order, with no catch-all section', async () => {
    const help = await topLevelHelp();
    const positions = HELP_GROUPS.map((g) => help.indexOf(`${g.heading}\n`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(help).not.toContain(`${OTHER_GROUP}\n`);
    expect(help).not.toContain('Commands:\n');
  });

  it("lists each group's commands under its heading, in table order", async () => {
    const help = await topLevelHelp();
    for (const group of HELP_GROUPS) {
      const expected = group.includesHelp ? [...group.commands, 'help'] : [...group.commands];
      expect(section(help, group.heading)).toEqual(expected);
    }
  });

  it('puts run-issue, ship, run, and land under "Run work:"', async () => {
    const runWork = section(await topLevelHelp(), 'Run work:');
    expect(runWork).toEqual(expect.arrayContaining(['run-issue', 'ship', 'run', 'land']));
  });

  it('says ship opens a PR and never merges, and run-issue is ship with an up-front issue check', async () => {
    const help = (await topLevelHelp()).replace(/\s+/g, ' ');
    expect(help).toContain('open a ready-for-review PR; never merges (merge later with land)');
    expect(help).toContain('Like ship, but loads the issue first');
  });
});

describe('ghRepoViewFailureMessage (#2592)', () => {
  it.each([undefined, '', 'no git remotes found'])('keeps the no-remote message for %j', (stderr) => {
    expect(ghRepoViewFailureMessage(stderr)).toBe('factory: no GitHub remote detected (gh repo view failed)');
  });

  it('keeps the no-remote message when no remote points to a known GitHub host (#2594)', () => {
    const msg = ghRepoViewFailureMessage(
      'none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`\n',
    );
    expect(msg).toBe('factory: no GitHub remote detected (gh repo view failed)');
    expect(msg).not.toContain('gh is not authenticated');
  });

  it('names gh authentication when gh says it is logged out', () => {
    const msg = ghRepoViewFailureMessage(
      'You are not logged into any GitHub hosts. Run gh auth login to authenticate.',
    );
    expect(msg).toContain('gh is not authenticated');
    expect(msg).toContain('`gh auth login`');
    expect(msg).not.toContain('no GitHub remote detected');
  });

  it.each([
    'HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login',
    'non-200 OK status code: 401 Unauthorized body: ...',
  ])('says the token was rejected and names the repo scope for %j', (stderr) => {
    const msg = ghRepoViewFailureMessage(stderr);
    expect(msg).toContain('rejected the token');
    expect(msg).toContain('`repo` scope');
    expect(msg).not.toContain('no GitHub remote detected');
    expect(msg).not.toContain('gh is not authenticated');
  });
});
