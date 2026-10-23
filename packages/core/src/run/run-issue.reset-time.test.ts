import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { ProviderCappedPayload } from '../events/kinds.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { BuildResult, buildPhase as realBuildPhase } from '../phases/build.js';
import type { CheckPhaseResult, checkPhase as realCheckPhase } from '../phases/check.js';
import type { PlanResult, planPhase as realPlanPhase } from '../phases/plan.js';
import type { ShipResult, shipPhase as realShipPhase } from '../phases/ship.js';
import { ClaudeCliHarness } from '../harness/claude-cli.js';
import { providerFailureOf } from '../harness/provider-failure.js';
import { makeContractRequest } from '../harness/contract.js';
import { ProviderBreaker } from '../router/breaker.js';
import { ModelRouter } from '../router/index.js';
import type { WorkRequest } from '../work/index.js';
import type { RunPolicy } from './policy.js';
import type { Workspace } from './ports.js';
import { runIssue, type RunPorts, type RunRequest } from './run-issue.js';

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

const breakerDir = mkdtempSync(join(tmpdir(), 'run-issue-reset-'));
afterAll(() => rmSync(breakerDir, { recursive: true, force: true }));

const request: RunRequest = {
  issue: 1,
  repo: 'o/r',
  branch: 'issue-1-fix-the-thing',
  specPath: '/tmp/wt/spec.md',
  work: WORK,
  startedAt: '2026-01-01T00:00:00.000Z',
  options: { interactive: false, autoRework: true, approvePlan: false, sandboxDisabled: false },
  timeouts: { plan: 60, build: 60, check: 60, approval: 60, tests: 60 },
  modelPins: { build: 'my-model', sources: { build: 'repo' } },
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

describe('runIssue — absolute provider reset time (#2884)', () => {
  it('honors an absolute "resets at" provider reset time', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-31T00:00:00Z'));
    try {
      const events: Array<[string, string]> = [];
      const planPhase = vi.fn<typeof realPlanPhase>().mockImplementation(async (opts) => {
        await opts.onProviderFailure?.({
          provider: 'opencode',
          reason: 'usage_cap',
          detail: 'OpenCode Go monthly usage limit reached. Your limit resets at 2026-11-01T00:00:00Z.',
        });
        return {
          ok: true,
          route: 'claude',
          specPath: '/tmp/wt/spec.md',
          model: 'm',
          designArtifact: null,
        } satisfies PlanResult;
      });
      const buildPhase = vi
        .fn<typeof realBuildPhase>()
        .mockResolvedValue({ ok: true, model: 'my-model', route: 'command' } satisfies BuildResult);
      const checkPhase = vi.fn<typeof realCheckPhase>().mockResolvedValue({
        passed: true,
        summary: { failures: 0, passes: 1, skips: 0, total: 1, results: [] },
        reworkRounds: 0,
      } satisfies CheckPhaseResult);
      const shipPhase = vi
        .fn<typeof realShipPhase>()
        .mockResolvedValue({ ok: true, prNumber: 42 } satisfies ShipResult);
      const ports: RunPorts = {
        router: new ModelRouter(MODELS, ROUTES),
        octokit: {} as Octokit,
        workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
        events: () => (type: string, msg: string) => events.push([type, msg]),
        breaker: new ProviderBreaker(join(breakerDir, 'breaker.json')),
        resolveConstitution: () => null,
        planPhase,
        buildPhase,
        checkPhase,
        shipPhase,
      };

      await runIssue({ ...request, failover: { ...request.failover, cooldownMs: 999 } }, policy, ports);

      expect(
        events.some(
          ([t, m]) =>
            t === 'provider_breaker_open' && m.includes('provider-reported reset time') && m.includes('1442m'),
        ),
      ).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('runIssue provider reset time', () => {
  type Failure = Parameters<NonNullable<Parameters<typeof realPlanPhase>[0]['onProviderFailure']>>[0];
  const run = async (failure: Failure, now: string, cooldownMs = 999, repeats = 1) => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(now));
    try {
      const events: Array<[string, string, { providerCapped?: ProviderCappedPayload }?]> = [];
      const breaker = new ProviderBreaker(join(breakerDir, `breaker-${Math.random()}.json`));
      const planPhase = vi.fn<typeof realPlanPhase>().mockImplementation(async (opts) => {
        for (let i = 0; i < repeats; i++) await opts.onProviderFailure?.(failure);
        return {
          ok: true,
          route: 'claude',
          specPath: '/tmp/wt/spec.md',
          model: 'm',
          designArtifact: null,
        } satisfies PlanResult;
      });
      const ports: RunPorts = {
        router: new ModelRouter(MODELS, ROUTES),
        octokit: {} as Octokit,
        workspace: { path: '/tmp/wt', dispose: async () => {} } as Workspace,
        events: () => (type: string, msg: string, extra?: { providerCapped?: ProviderCappedPayload }) =>
          events.push([type, msg, extra]),
        breaker,
        resolveConstitution: () => null,
        planPhase,
        buildPhase: vi
          .fn<typeof realBuildPhase>()
          .mockResolvedValue({ ok: true, model: 'my-model', route: 'command' } satisfies BuildResult),
        checkPhase: vi.fn<typeof realCheckPhase>().mockResolvedValue({
          passed: true,
          summary: { failures: 0, passes: 1, skips: 0, total: 1, results: [] },
          reworkRounds: 0,
        } satisfies CheckPhaseResult),
        shipPhase: vi.fn<typeof realShipPhase>().mockResolvedValue({ ok: true, prNumber: 42 } satisfies ShipResult),
      };
      await runIssue({ ...request, failover: { ...request.failover, cooldownMs } }, policy, ports);
      return { events, status: await breaker.status(failure.provider) };
    } finally {
      nowSpy.mockRestore();
    }
  };

  it('a Claude weekly-limit error holds the claude breaker until the reported reset', async () => {
    const now = '2026-10-18T22:39:00Z';
    const weekly = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: "You've hit your weekly limit · resets Oct 20 at 7am (America/Chicago)",
      duration_api_ms: 50,
      usage: { input_tokens: 3, output_tokens: 4 },
    });
    const harness = new ClaudeCliHarness(
      async () => ({ stdout: weekly, stderr: '' }),
      () => Date.now(),
    );
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(now));
    let failure;
    try {
      const err = await harness.run(makeContractRequest()).catch((e) => e);
      failure = providerFailureOf(err);
    } finally {
      nowSpy.mockRestore();
    }
    expect(failure.kind).toBe('usage_cap');
    const { events, status } = await run(
      {
        provider: 'anthropic',
        reason: failure.reason,
        kind: failure.kind,
        resetAt: failure.resetAt,
        detail: failure.detail,
      },
      now,
    );
    expect(events.some(([t, m]) => t === 'provider_breaker_open' && m.includes('provider-reported reset time'))).toBe(
      true,
    );
    if (!status.open) throw new Error('expected an open breaker');
    expect(Date.parse(status.entry.openedAt) + status.entry.cooldownMs).toBe(Date.parse('2026-10-20T12:02:00Z'));
  });

  it('falls back to the detail hint then the default cooldown', async () => {
    const hinted = await run(
      { provider: 'opencode', reason: 'usage_cap', kind: 'usage_cap', detail: 'Resets in 3hr 17min' },
      '2026-10-18T22:39:00Z',
    );
    expect(hinted.events.some(([, m]) => m.includes('provider-reported reset time') && m.includes('199m'))).toBe(true);
    const plain = await run(
      { provider: 'opencode', reason: 'rate_limit', kind: 'rate_limit', detail: 'no hint here' },
      '2026-10-18T22:39:00Z',
      600_000,
    );
    expect(plain.events.some(([, m]) => m.includes('default cooldown') && m.includes('10m'))).toBe(true);
    const past = await run(
      { provider: 'opencode', reason: 'rate_limit', kind: 'rate_limit', resetAt: '2026-10-01T00:00:00.000Z' },
      '2026-10-18T22:39:00Z',
      600_000,
    );
    expect(past.events.some(([, m]) => m.includes('default cooldown'))).toBe(true);
    const cap = await run(
      { provider: 'opencode', reason: 'usage_cap', kind: 'usage_cap', detail: 'no hint here' },
      '2026-10-18T22:39:00Z',
      600_000,
    );
    expect(cap.events.some(([, m]) => m.includes('re-probe after 1h') && m.includes('60m'))).toBe(true);
  });

  it('a usage cap marks the provider capped until its reset and emits provider_capped once (2026-10-20)', async () => {
    const { events, status } = await run(
      { provider: 'claude', reason: 'usage_cap', kind: 'usage_cap', resetAt: '2026-10-21T12:00:00Z' },
      '2026-10-21T10:00:00Z',
      999,
      2,
    );
    if (!status.open) throw new Error('expected an open breaker');
    expect(status.entry.cappedUntil).toBe('2026-10-21T12:02:00.000Z');
    expect(Date.parse(status.entry.openedAt) + status.entry.cooldownMs).toBe(Date.parse('2026-10-21T12:02:00Z'));
    const capped = events.filter(([t]) => t === 'provider_capped');
    expect(capped).toHaveLength(1);
    expect(capped[0][2]?.providerCapped).toMatchObject({
      source: 'reported',
      stage: 'plan',
      issue: 1,
      provider: 'claude',
      cappedUntil: '2026-10-21T12:02:00.000Z',
    });
  });

  it('a usage cap with no reported reset re-probes after 1 hour; other kinds keep cooldown_minutes', async () => {
    const cap = await run({ provider: 'claude', reason: 'usage_cap', kind: 'usage_cap' }, '2026-10-21T13:00:00Z');
    if (!cap.status.open) throw new Error('expected an open breaker');
    expect(cap.status.entry.cappedUntil).toBe('2026-10-21T14:00:00.000Z');
    expect(cap.status.entry.probeDue).toBe(true);
    expect(cap.events.find(([t]) => t === 'provider_capped')?.[2]?.providerCapped?.source).toBe('default-1h');
    const rate = await run(
      { provider: 'claude', reason: 'rate_limit', kind: 'rate_limit' },
      '2026-10-21T13:00:00Z',
      1_800_000,
    );
    if (!rate.status.open) throw new Error('expected an open breaker');
    expect(rate.status.entry.cooldownMs).toBe(1_800_000);
    expect(rate.status.entry.cappedUntil).toBeUndefined();
    expect(rate.status.entry.probeDue).toBeUndefined();
    expect(rate.events.some(([t]) => t === 'provider_capped')).toBe(false);
  });

  it('three usage caps on one open provider write exactly one provider_capped', async () => {
    const { events } = await run(
      { provider: 'claude', reason: 'usage_cap', kind: 'usage_cap' },
      '2026-10-21T13:00:00Z',
      999,
      3,
    );
    expect(events.filter(([t]) => t === 'provider_capped')).toHaveLength(1);
    expect(events.filter(([t]) => t === 'provider_breaker_open')).toHaveLength(3);
  });

  it('provider_capped detail is redacted', async () => {
    const { events } = await run(
      { provider: 'claude', reason: 'usage_cap', kind: 'usage_cap', detail: 'limit hit key sk-ant-abc123 here' },
      '2026-10-21T13:00:00Z',
    );
    const detail = events.find(([t]) => t === 'provider_capped')?.[2]?.providerCapped?.detail;
    expect(detail).toContain('[redacted]');
    expect(detail).not.toContain('sk-ant-abc123');
  });
});
