// packages/cli/src/cli/ship.test.ts — Ship flow (direct) tests: worktree, config seams, slice branch, standards logging (#2789)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as FactoryCore from '@on-par/factory-core';
import { renderSlicePlanComment } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';

import { type CliDeps, IssueSkippedError, LaneParkError } from './index.js';
import {
  coreFakes,
  defaultOctokit,
  h,
  inertConfigLoaders,
  installShipHarness,
  paths,
  phases,
  runMainWith,
  setupWorktree,
  shipIssue,
} from './test-support/ship-harness.js';

installShipHarness();

describe('shipIssue (direct)', () => {
  const ctx = () => ({ repoRoot: h.repoRoot, ghRepo: h.ghRepo });

  it('uses an injected setupWorktree over the default git ops (#2019)', async () => {
    const custom = vi.fn(async (..._args: Parameters<NonNullable<CliDeps['setupWorktree']>>) => undefined as never);
    await shipIssue(5, {}, ctx(), { setupWorktree: custom });
    expect(custom.mock.calls[0]?.slice(0, 3)).toEqual([h.repoRoot, expect.any(String), expect.any(String)]);
    expect(setupWorktree).not.toHaveBeenCalled();
  });

  describe('slice branch (ADR-0147)', () => {
    const sliceStory = (n: number) => ({
      schemaVersion: 1 as const,
      kind: 'story' as const,
      filesLikelyTouched: [],
      labels: [],
      title: `Story ${n}`,
      role: 'operator',
      want: `thing ${n} works`,
      soThat: 'value',
      problemStatement: `Problem ${n}`,
      inScope: [`Scope ${n}`],
      outOfScope: ['Persistent storage'],
      acceptanceCriteria: [{ name: `ac ${n}`, given: [], when: ['run'], then: ['works'] }],
      verification: [{ command: 'npm test', passWhen: 'passes' }],
      tracesTo: ['INT-PROBLEM-01'],
    });
    const planComment = renderSlicePlanComment({
      issue: 5,
      slices: [
        { index: 1, title: 'One', story: sliceStory(1) as never, state: 'merged', prNumber: 10 },
        { index: 2, title: 'Two', story: sliceStory(2) as never, state: 'pending' },
      ],
    });
    const sliceOctokit = (listComments: () => Promise<unknown>) => {
      const fake = defaultOctokit() as any;
      fake.rest.issues.listComments = vi.fn(listComments);
      return fake;
    };
    const custom = () =>
      vi.fn(async (..._args: Parameters<NonNullable<CliDeps['setupWorktree']>>) => undefined as never);

    it('builds slice 2 on the -s2- branch when slice 1 is merged', async () => {
      const setup = custom();
      const fake = sliceOctokit(async () => ({ data: [{ id: 1, user: { id: 7 }, body: planComment }] }));
      await shipIssue(5, { sizeGate: 'slice' }, ctx(), { setupWorktree: setup, octokit: () => fake });
      expect(setup.mock.calls[0]?.[1]).toBe('factory/5-s2-fix-the-bug');
    });

    it('does not look up the slice plan in file mode', async () => {
      const setup = custom();
      const fake = sliceOctokit(async () => ({ data: [] }));
      await shipIssue(5, { sizeGate: 'file' }, ctx(), { setupWorktree: setup, octokit: () => fake });
      expect(fake.rest.issues.listComments).not.toHaveBeenCalled();
      expect(setup.mock.calls[0]?.[1]).toBe('factory/5-fix-the-bug');
    });

    it('parks before creating a worktree when the slice plan lookup throws', async () => {
      const setup = custom();
      const fake = sliceOctokit(async () => {
        throw new Error('network down');
      });
      await expect(
        shipIssue(5, { sizeGate: 'slice' }, ctx(), { setupWorktree: setup, octokit: () => fake }),
      ).rejects.toBeInstanceOf(LaneParkError);
      expect(setup).not.toHaveBeenCalled();
    });
  });

  it('uses the injected octokit factory instead of the default client', async () => {
    const fake = defaultOctokit();
    const factory = vi.fn(() => fake as never);
    const defaultGet = h.octokit.rest.issues.get;

    await shipIssue(5, {}, ctx(), { octokit: factory });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(fake.rest.issues.get).toHaveBeenCalled();
    expect(defaultGet).not.toHaveBeenCalled();
  });

  it('main() routes deps.octokit to GitHub-backed commands', async () => {
    const fake = defaultOctokit();
    fake.rest.pulls.list = vi.fn(async () => ({ data: [] }));
    const factory = vi.fn(() => fake as never);
    const defaultList = h.octokit.rest.pulls.list;

    await runMainWith({ octokit: factory }, 'land', '5');

    expect(factory).toHaveBeenCalled();
    expect(fake.rest.pulls.list).toHaveBeenCalled();
    expect(defaultList).not.toHaveBeenCalled();
  });

  it('uses injected resolveTimeouts, resolveSkipCI and resolveEffectiveModelPins', async () => {
    const timeouts = vi.fn(() => ({ plan: 1, build: 1, check: 1, approval: 1, tests: 1 }));
    const skip = vi.fn(() => false);
    const pins = vi.fn(() => ({
      plan: undefined,
      planFallback: undefined,
      build: undefined,
      buildFallback: undefined,
      sources: {},
    }));

    await shipIssue(5, {}, ctx(), {
      resolveTimeouts: timeouts as never,
      resolveSkipCI: skip,
      resolveEffectiveModelPins: pins as never,
    });

    expect(timeouts).toHaveBeenCalledWith(h.factoryConfig);
    expect(skip).toHaveBeenCalledWith(h.factoryConfig);
    expect(pins).toHaveBeenCalled();
    expect(inertConfigLoaders.resolveEffectiveModelPins).not.toHaveBeenCalled();
  });

  it('uses injected loadFactoryConfigForRepo and loadRepoConfig', async () => {
    const repoValue = FactoryCore.loadRepoConfig(h.repoRoot);
    const factoryConfig = vi.fn(() => h.factoryConfig);
    const repoConfig = vi.fn(() => repoValue);

    await shipIssue(5, {}, ctx(), {
      loadFactoryConfigForRepo: factoryConfig as never,
      loadRepoConfig: repoConfig as never,
    });

    expect(factoryConfig).toHaveBeenCalledWith(expect.stringMatching(/\.factory\/config\.(json|yaml)$/));
    expect(repoConfig).toHaveBeenCalledWith(h.repoRoot, paths().root);
  });

  it('uses an injected loadModelsConfig and loadRoutesConfig', async () => {
    const modelsValue = { models: { 'distinctive-model-2064': {} }, tiers: {} };
    const routesValue = { 'distinctive-route-2064': {} };
    const models = vi.fn(() => modelsValue as never);
    const routes = vi.fn(() => routesValue as never);

    await shipIssue(5, {}, ctx(), { loadModelsConfig: models, loadRoutesConfig: routes });

    expect(models).toHaveBeenCalled();
    expect(routes).toHaveBeenCalled();
    expect(coreFakes.ModelRouter.mock.calls.at(-1)?.[0]).toMatchObject(modelsValue);
    expect(coreFakes.ModelRouter.mock.calls.at(-1)?.[1]).toMatchObject(routesValue);
  });

  it('uses the h.octokit client injected through the shared ops fakes', async () => {
    await shipIssue(5, {}, ctx());
    expect(h.octokit.rest.issues.get).toHaveBeenCalled();
  });

  it('forwards an injected shipPhase override into RunPorts instead of the default', async () => {
    const ship = vi.fn(async () => h.shipResult);

    await shipIssue(5, {}, ctx(), { shipPhase: ship as never });

    expect(ship).toHaveBeenCalledTimes(1);
    expect(phases.shipPhase).not.toHaveBeenCalled();
  });

  it('drives the deps-builder phase doubles when the test passes no override', async () => {
    await shipIssue(5, {}, ctx());
    expect(phases.planPhase).toHaveBeenCalled();
    expect(phases.shipPhase).toHaveBeenCalled();
    await expect(phases.planPhase.mock.results[0]?.value).resolves.toBe(h.planResult);
  });

  it('main() forwards phase overrides to the shipIssue it runs', async () => {
    const customPlan = vi.fn(async (_opts) => h.planResult);
    await runMainWith({ planPhase: customPlan as never }, 'ship', '5');
    expect(customPlan).toHaveBeenCalled();
    expect(phases.planPhase).not.toHaveBeenCalled();
  });

  it('restores the default phases after main() returns', async () => {
    const customShip = vi.fn(async (_opts) => h.shipResult);
    await runMainWith({ shipPhase: customShip as never }, 'ship', '5');
    const calls = customShip.mock.calls.length;
    await shipIssue(5, {}, ctx());
    expect(customShip).toHaveBeenCalledTimes(calls);
    expect(phases.shipPhase).toHaveBeenCalled();
  });

  it('uses the branchPrefix override for the branch name', async () => {
    expect(await shipIssue(5, { branchPrefix: 'sf' }, ctx())).toBe('sf/5-fix-the-bug');
  });

  it('returns the branch on the happy path and logs a ready event', async () => {
    const branch = await shipIssue(5, {}, ctx());
    expect(branch).toBe('factory/5-fix-the-bug');
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('ready');
    expect(events).toContain('worktree');
  });

  it('loads the committed repo config from paths.root, not paths.state', async () => {
    const spy = vi.fn(FactoryCore.loadRepoConfig);
    await shipIssue(5, {}, ctx(), { loadRepoConfig: spy as never });
    expect(spy).toHaveBeenCalledWith(h.repoRoot, paths().root);
  });

  it('keeps a claude-cli build pin on the claude route when PLAN picks codex (#1367)', async () => {
    h.modelOverrides = { build: 'claude-sonnet-5' };
    h.modelProviders = { 'claude-sonnet-5': 'anthropic' };
    h.planResult = { ok: true, route: 'codex' };

    await shipIssue(5, {}, ctx());

    expect(phases.planPhase.mock.calls.at(-1)?.[0]).toMatchObject({ preferredRoute: 'claude' });
    expect(phases.buildPhase.mock.calls.at(-1)?.[0]).toMatchObject({
      route: 'claude',
      modelOverride: 'claude-sonnet-5',
    });
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('build model pinned to claude-sonnet-5');
    expect(events).toContain('build route derived from pinned build model claude-sonnet-5 → claude');
    expect(events).not.toContain('model_override_ignored');
  });

  it('reads providers flags from .factory/config.json (no symlink needed)', async () => {
    mkdirSync(paths().root, { recursive: true });
    writeFileSync(paths().config, JSON.stringify({ version: 1, providers: { ollama: false } }));
    const spy = vi.fn(FactoryCore.loadRepoConfig);
    await shipIssue(5, {}, ctx(), { loadRepoConfig: spy as never });
    expect(spy.mock.results.at(-1)?.value).toEqual({
      version: 2,
      providers: { ollama: false },
    });
  });

  // Regression (#681): a closed issue must be refused before any resource is
  // committed — no worktree, no port lease, no model call.
  it('refuses a closed issue before any resource is committed', async () => {
    h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix the bug', state: 'closed' } }));

    await expect(shipIssue(5, {}, ctx())).rejects.toBeInstanceOf(IssueSkippedError);

    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('skipped-already-closed');
    expect(events).not.toContain('"type":"worktree"');
    expect(events).not.toContain('"type":"environment_lease"');
    expect(events).not.toContain('"type":"plan"');
    expect(events).not.toContain('"type":"ready"');
  });

  it('logs an issue-title event with the fetched title before any other events', async () => {
    await shipIssue(5, {}, ctx());
    const events = readFileSync(paths().events, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({ type: 'issue-title', issue: '5', msg: 'Fix the bug' });
  });

  it('logs model-override events when overrides are pinned', async () => {
    h.modelOverrides = { plan: 'plan-x', build: 'build-y' };
    await shipIssue(5, {}, ctx());
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('plan-x');
    expect(events).toContain('build-y');
  });

  it('logs one model-override per pinned phase naming .factory/config.yaml (#2497)', async () => {
    mkdirSync(paths().root, { recursive: true });
    writeFileSync(
      `${paths().root}/config.yaml`,
      'version: 2\nmodels:\n  pins:\n    triage: triage-x\n    plan: plan-x\n    build: build-y\n    checker: checker-z\n',
    );
    const models = vi.fn(
      () =>
        ({
          models: Object.fromEntries(
            ['triage-x', 'plan-x', 'build-y', 'checker-z'].map((id) => [id, { provider: 'anthropic' }]),
          ),
          tiers: {},
        }) as never,
    );
    const pins = vi.fn(() => ({
      plan: 'plan-x',
      planFallback: undefined,
      build: 'build-y',
      buildFallback: undefined,
      sources: { plan: 'repo', build: 'repo' },
    }));
    await shipIssue(5, {}, ctx(), { loadModelsConfig: models, resolveEffectiveModelPins: pins as never });
    const lines = readFileSync(paths().events, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((e) => e.type === 'model-override' && / model pinned to /.test(e.msg));
    expect(lines.map((e) => e.msg)).toEqual([
      'triage model pinned to triage-x (.factory/config.yaml)',
      'plan model pinned to plan-x (.factory/config.yaml)',
      'build model pinned to build-y (.factory/config.yaml)',
      'checker model pinned to checker-z (.factory/config.yaml)',
    ]);
  });

  it('remembers a capped planning provider and uses the configured fallback on the next issue', async () => {
    h.modelOverrides = { plan: 'claude-plan', planFallback: 'gpt-plan' };
    h.modelProviders = { 'claude-plan': 'anthropic', 'gpt-plan': 'openai' };
    h.triggerPlanProviderFailure = { provider: 'anthropic', reason: 'usage_cap' };

    await shipIssue(5, {}, ctx());
    expect(readFileSync(paths().events, 'utf-8')).toContain('provider_breaker_open');

    h.triggerPlanProviderFailure = null;
    await shipIssue(6, {}, ctx());
    const planCall = phases.planPhase.mock.calls.at(-1)?.[0];
    expect(planCall).toMatchObject({ modelOverride: 'claude-plan', modelFallbacks: ['gpt-plan'] });
    expect([...(planCall?.skipProviders ?? [])]).toEqual(['anthropic']);
  });

  it('cools down a weekly-usage-cap provider for the reported reset time, not the flat default', async () => {
    h.modelOverrides = { plan: 'claude-plan', planFallback: 'gpt-plan' };
    h.modelProviders = { 'claude-plan': 'anthropic', 'gpt-plan': 'openai' };
    h.triggerPlanProviderFailure = {
      provider: 'anthropic',
      reason: 'usage_cap',
      detail: 'msg="AI_APICallError: Weekly usage limit reached. Resets in 3hr 17min. To continue..."',
    };

    await shipIssue(5, {}, ctx());

    const breakerFile = JSON.parse(readFileSync(paths().breaker, 'utf-8'));
    expect(breakerFile.providers.anthropic.cooldownMs).toBe((3 * 60 + 17) * 60_000 + 2 * 60_000);
  });

  it('skips a cooled-down Claude build provider and starts the frozen build on its Codex fallback', async () => {
    h.modelOverrides = { build: 'claude-build', buildFallback: 'gpt-build' };
    h.modelProviders = { 'claude-build': 'anthropic', 'gpt-build': 'openai' };
    writeFileSync(
      paths().breaker,
      JSON.stringify({
        version: 1,
        providers: {
          anthropic: { reason: 'timeout', openedAt: new Date().toISOString(), cooldownMs: 60_000 },
        },
      }),
    );

    await shipIssue(5, {}, ctx());

    expect(phases.buildPhase.mock.calls.at(-1)?.[0]).toMatchObject({
      route: 'codex',
      modelOverride: 'gpt-build',
      codexFallbackModel: 'gpt-build',
    });
  });

  it('logs standards source when a repo constitution resolves', async () => {
    h.constitutionResolve = () => ({ source: 'repo', product: 'alpha' });
    await shipIssue(5, { product: 'alpha' }, ctx());
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('Standards from repo instruction files');
  });

  it('passes the main checkout as the constitution source', async () => {
    const resolveSpy = vi.fn((..._args: any[]): any => null);
    h.constitutionResolve = resolveSpy;
    await shipIssue(5, {}, ctx());
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    const args = resolveSpy.mock.calls[0]!;
    expect(args[3]).toBe(h.repoRoot);
    expect(args[0]).not.toBe(h.repoRoot);
  });

  it('logs bundled standards source when a bundled constitution resolves', async () => {
    h.constitutionResolve = () => ({ source: 'bundled', product: 'beta' });
    await shipIssue(5, {}, ctx());
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain("bundled constitution 'beta'");
  });
});

describe('shipIssue review rework (#3564)', () => {
  const ctx = () => ({ repoRoot: h.repoRoot, ghRepo: h.ghRepo });
  const seed = (extra: Record<string, unknown> = {}) =>
    writeFileSync(
      join(paths().state, 'review-rework.json'),
      JSON.stringify({
        reviews: [
          {
            reviewId: 200,
            pr: 77,
            issue: 5,
            lane: 'bugfix',
            reviewer: 'alice',
            queuedAt: '2026-01-01T00:00:00.000Z',
            ...extra,
          },
        ],
      }),
    );
  const closedPr = () => {
    const fake = defaultOctokit() as any;
    fake.rest.pulls.get = vi.fn(async () => ({ data: { state: 'closed', head: { ref: 'factory/5-fix-the-bug' } } }));
    return fake;
  };

  it('claims a pending record: skips PLAN, sends reviewRework on the request and marks it started', async () => {
    seed();
    const fake = closedPr();
    await expect(shipIssue(5, {}, ctx(), { octokit: () => fake })).rejects.toThrow(/PR #77 must be open/);
    expect(phases.planPhase).not.toHaveBeenCalled();
    expect(fake.rest.pulls.get).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 77 }));
    const saved = JSON.parse(readFileSync(join(paths().state, 'review-rework.json'), 'utf-8'));
    expect(saved.reviews[0].startedAt).toEqual(expect.any(String));
  });

  it('runs normally when the record is already started or absent', async () => {
    seed({ startedAt: '2026-01-02T00:00:00.000Z' });
    await shipIssue(5, {}, ctx());
    expect(phases.planPhase).toHaveBeenCalled();
  });
});
