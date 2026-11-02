// packages/cli/src/cli/test-support/cli-commands-harness.ts — shared setup for the cli command suites (#3809)
// Preamble for every suite that uses it (path relative to packages/cli/src/cli/):
//   import { h, installCliCommandsHarness, logged, runMain } from './test-support/cli-commands-harness.js';
//   installCliCommandsHarness();
// No vi.mock: every dependency is injected through CliDeps seams (anti-slop/no-module-mocking).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, vi } from 'vitest';

import type { DaemonCtlDeps } from '../daemon.js';
import { type CliDeps, cmdUsage as cliCmdUsage, main, shipIssue as cliShipIssue } from '../index.js';
import {
  coreFakes,
  defaultOctokit,
  ExitError,
  h,
  inertConfigLoaders,
  inertGitOps,
  ops,
  paths,
  phases,
  resetFakes,
  savedEnv,
  trackEnv,
} from './cli-commands-state.js';

export * from './cli-commands-state.js';

export let exitSpy: any;
export let logSpy: any;
export let errSpy: any;

export const tmp = createTempDirs();

/** Direct shipIssue calls get the inert models/routes loaders unless a test passes its own. */
export function shipIssue(...[issueNum, opts, ctx, deps]: Parameters<typeof cliShipIssue>) {
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
export function cmdUsage(deps: Parameters<typeof cliCmdUsage>[0] = {}) {
  return cliCmdUsage({ ...ops, ...coreFakes, ...deps });
}

export const recordingRunTui: NonNullable<CliDeps['runTui']> = async (opts) => {
  h.runTuiCalls.push(opts);
};

export function daemonDeps(): DaemonCtlDeps {
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
    sleep: () => Promise.resolve(),
  };
}

export async function runMain(...args: string[]) {
  process.argv = ['node', 'factory', ...args];
  return runMainWith({ daemon: daemonDeps(), runTui: recordingRunTui }, ...args);
}

export async function runMainWith(deps: CliDeps | undefined, ...args: string[]) {
  return runMainRaw({ ...inertConfigLoaders, ...deps }, ...args);
}

export async function runMainRaw(deps: CliDeps | undefined, ...args: string[]) {
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

export function installCliCommandsHarness(): void {
  beforeEach(() => {
    resetFakes();
    h.repoRoot = tmp.makeSync('factory-cli-');
    h.constitutionsDir = tmp.makeSync('factory-const-');
    h.daemonHome = tmp.makeSync('factory-daemon-home-');
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

  afterEach(async () => {
    await tmp.cleanup();
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
}

export function logged(): string {
  return logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
}
export function errored(): string {
  return errSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
}
