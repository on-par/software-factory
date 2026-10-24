import { workKeyFromIssue } from '../work/work-key.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { buildPhase as realBuildPhase } from '../phases/build.js';
import type { checkPhase as realCheckPhase } from '../phases/check.js';
import type { planPhase as realPlanPhase } from '../phases/plan.js';
import type { shipPhase as realShipPhase } from '../phases/ship.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import type { CommandResult } from '../utils/command-runner.js';
import type { WorkRequest } from '../work/index.js';
import { installLaneDependencies } from './lane-install.js';
import type { RunPolicy } from './policy.js';
import type { Workspace } from './ports.js';
import { runIssue, type RunRequest } from './run-issue.js';

const WORK: WorkRequest = {
  id: 'github-issue:o/r#1',
  kind: 'github-issue',
  title: 'Fix the thing',
  brief: 'do the thing',
  acceptanceCriteria: [],
};

const ROUTES: RoutesConfig = {
  version: 1,
  routes: {
    build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
    build_command: { tier: 'worker', description: 'stub', requires: 'command' },
  },
};

const MODELS: ModelsConfig = {
  version: 1,
  models: {
    'my-model': {
      provider: 'custom',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'my-agent',
    },
  },
  tiers: { worker: ['my-model'] },
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
  harnesses: {
    'my-agent': { command: 'my-agent {model}', prompt: 'stdin', output: 'stdout', agentic: true, usage: 'none' },
  },
};

const dirs = createTempDirs();
const breakerDir = dirs.makeSync('run-issue-lane-install-');
afterAll(() => dirs.cleanup());

const request: RunRequest = {
  issue: workKeyFromIssue(1),
  repo: 'o/r',
  branch: 'issue-1-fix-the-thing',
  specPath: '/tmp/wt/spec.md',
  work: WORK,
  startedAt: '2026-01-01T00:00:00.000Z',
  options: { interactive: false, autoRework: true, approvePlan: false, sandboxDisabled: false },
  timeouts: { plan: 60, build: 60, check: 60, approval: 60, tests: 60 },
  modelPins: { sources: {} },
  codexDisabled: false,
  skipCI: false,
  failover: { enabled: false, cooldownMs: 60_000, fallbackModel: 'claude-sonnet-5' },
  efficiency: { maxReworkRounds: 1, fastPath: false },
  processGroupGraceMs: 50,
};

const policy: RunPolicy = {
  models: MODELS,
  routes: ROUTES,
  sandbox: {
    enabled: false,
    runtime: 'auto',
    network: { allow: [] },
    resources: { cpuMs: 0, memMb: 0 },
    docker: { rolloutPercent: 0 },
  },
  budget: {},
  effective: {} as RunPolicy['effective'],
};

function commandResult(over: Partial<CommandResult> = {}): CommandResult {
  return { command: [], stdout: '', stderr: '', exitCode: 0, killed: false, timedOut: false, ok: true, ...over };
}

async function harness(files: string[], installResult: CommandResult = commandResult()) {
  const wt = await dirs.make('lane-wt-');
  for (const f of files) {
    if (f === 'node_modules') await mkdir(join(wt, f));
    else await writeFile(join(wt, f), '');
  }
  const order: string[] = [];
  const installStub = vi.fn(async (_argv: readonly string[], _opts?: { cwd?: string }) => {
    order.push('install');
    return installResult;
  });
  const buildPhase = vi.fn<typeof realBuildPhase>(async () => {
    order.push('build');
    return { ok: false, model: 'm', route: 'claude', reason: 'no_diff' };
  });
  const planPhase = vi
    .fn<typeof realPlanPhase>()
    .mockResolvedValue({ ok: true, route: 'claude', specPath: '/tmp/wt/spec.md', model: 'm', designArtifact: null });
  const events: Array<[string, string]> = [];
  const ports = {
    router: new ModelRouter(MODELS, ROUTES),
    octokit: {} as Octokit,
    workspace: { path: wt, dispose: async () => {} } as Workspace,
    events: () => (t: string, m: string) => {
      events.push([t, m]);
    },
    breaker: new ProviderBreaker(join(breakerDir, `breaker-${Math.random()}.json`)),
    resolveConstitution: () => null,
    planPhase,
    buildPhase,
    checkPhase: vi.fn<typeof realCheckPhase>(),
    shipPhase: vi.fn<typeof realShipPhase>(),
    installLaneDependencies: (o: Parameters<typeof installLaneDependencies>[0]) =>
      installLaneDependencies({ ...o, runCommand: installStub }),
  };
  return { wt, order, installStub, buildPhase, events, ports };
}

describe('runIssue — lane dependency install (#3370)', () => {
  it('installs lane dependencies with the frozen lockfile install before the BUILD worker (T14)', async () => {
    const h = await harness(['package.json', 'package-lock.json']);
    await runIssue(request, policy, h.ports);
    expect(h.order[0]).toBe('install');
    expect(h.order.indexOf('install')).toBeLessThan(h.order.indexOf('build'));
    expect(h.installStub).toHaveBeenCalledTimes(1);
    expect(h.installStub.mock.calls[0][0]).toEqual(['npm', 'ci', '--no-audit', '--no-fund']);
    expect(h.installStub.mock.calls[0][1]?.cwd).toBe(h.wt);
  });

  it('runs the pnpm frozen install in the worktree before the BUILD worker when pnpm-lock.yaml is present', async () => {
    const h = await harness(['package.json', 'pnpm-lock.yaml']);
    await runIssue(request, policy, h.ports);
    expect(h.installStub.mock.calls[0][0]).toEqual(['pnpm', 'install', '--frozen-lockfile']);
    expect(h.installStub.mock.calls[0][1]?.cwd).toBe(h.wt);
    expect(h.order).toEqual(['install', 'build']);
  });

  it('skips the install and logs the reason when node_modules already exists', async () => {
    const h = await harness(['package.json', 'package-lock.json', 'node_modules']);
    await runIssue(request, policy, h.ports);
    expect(h.installStub).not.toHaveBeenCalled();
    expect(h.events.some(([t, m]) => t === 'lane_install' && m.includes('node_modules'))).toBe(true);
    expect(h.buildPhase).toHaveBeenCalled();
  });

  it('logs lane_install_failed with the command and still calls the BUILD worker when the install exits non-zero', async () => {
    const h = await harness(
      ['package.json', 'pnpm-lock.yaml'],
      commandResult({ ok: false, exitCode: 1, stderr: 'ERR_PNPM_OUTDATED_LOCKFILE' }),
    );
    await runIssue(request, policy, h.ports);
    const failed = h.events.find(([t]) => t === 'lane_install_failed');
    expect(failed?.[1]).toContain('pnpm install --frozen-lockfile');
    expect(failed?.[1]).toContain('ERR_PNPM_OUTDATED_LOCKFILE');
    expect(h.buildPhase).toHaveBeenCalledTimes(1);
  });

  it('does not abort the run when an injected install port rejects', async () => {
    const h = await harness([]);
    h.ports.installLaneDependencies = async () => {
      throw new Error('boom');
    };
    await runIssue(request, policy, h.ports);
    expect(h.events.some(([t, m]) => t === 'lane_install_failed' && m.includes('boom'))).toBe(true);
    expect(h.buildPhase).toHaveBeenCalledTimes(1);
  });
});
