// packages/cli/src/cli/ship.test.ts — Ship flow (direct) tests: worktree, config seams, slice branch, standards logging (#2789)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as FactoryCore from '@on-par/factory-core';
import type { RunOutcome } from '@on-par/factory-core';
import { renderSlicePlanComment } from '@on-par/factory-core/internal';
import { describe, expect, it } from 'vitest';

import { type CliDeps, IssueSkippedError, LaneParkError } from './index.js';
import {
  coreFakes,
  defaultOctokit,
  h,
  installShipHarness,
  paths,
  phases,
  runMainWith,
  shipIssue,
} from './test-support/ship-harness.js';

installShipHarness();

type PlanOpts = Parameters<NonNullable<CliDeps['planPhase']>>[0];
type BuildOpts = Parameters<NonNullable<CliDeps['buildPhase']>>[0];
type SetupArgs = Parameters<NonNullable<CliDeps['setupWorktree']>>;
const recordPhases = () => {
  const [plan, build]: [PlanOpts[], BuildOpts[]] = [[], []];
  return {
    plan,
    build,
    deps: {
      planPhase: async (o: PlanOpts) => (plan.push(o), phases.planPhase(o)),
      buildPhase: async (o: BuildOpts) => (build.push(o), phases.buildPhase(o)),
    } satisfies Pick<CliDeps, 'planPhase' | 'buildPhase'>,
  };
};
const recordSetup = () => {
  const calls: SetupArgs[] = [];
  return { calls, setupWorktree: async (...a: SetupArgs) => (calls.push(a), undefined as never) };
};
const ctx = () => ({ repoRoot: h.repoRoot, ghRepo: h.ghRepo });
const outcomeCtx = () => {
  const seen: RunOutcome[] = [];
  return { seen, ctx: { repoRoot: h.repoRoot, ghRepo: h.ghRepo, onOutcome: (o: RunOutcome) => void seen.push(o) } };
};
const spy =
  <A extends unknown[], R>(log: unknown[][], fn: (...a: A) => R) =>
  (...a: A) => (log.push(a), fn(...a));

describe('shipIssue (direct)', () => {
  it('uses an injected setupWorktree over the default git ops (#2019)', async () => {
    const { calls, setupWorktree: custom } = recordSetup();
    const defaultHits: unknown[][] = [];
    h.setupWorktreeImpl = spy(defaultHits, async () => {});
    await shipIssue(5, {}, ctx(), { setupWorktree: custom });
    expect(calls[0]?.slice(0, 3)).toEqual([h.repoRoot, expect.any(String), expect.any(String)]);
    expect(defaultHits).toEqual([]);
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
    const stored = async () => ({ data: [{ id: 1, user: { id: 7 }, body: planComment }] });
    const sliceRun = async (
      opts: Parameters<typeof shipIssue>[1],
      listComments: () => Promise<unknown>,
      extra = {},
    ) => {
      const fake = defaultOctokit() as any;
      const listArgs: unknown[][] = [];
      fake.rest.issues.listComments = spy(listArgs, listComments);
      const { calls, setupWorktree } = recordSetup();
      const err = await shipIssue(5, opts, ctx(), { setupWorktree, octokit: () => fake, ...extra }).then(
        () => undefined,
        (e: unknown) => e,
      );
      return { err, calls, listArgs };
    };

    it('builds slice 2 on the -s2- branch when slice 1 is merged', async () => {
      const r = await sliceRun({ sizeGate: 'stack' }, stored);
      expect(r.calls[0]?.[1]).toBe('factory/5-s2-fix-the-bug');
    });

    it('keeps a chain member whole and passes the stack gate with a base', async () => {
      const { plan, deps } = recordPhases();
      const r = await sliceRun({ sizeGate: 'stack', baseBranch: 'main', parkOverBudget: true }, stored, deps);
      expect(r.listArgs.some(([a]: any) => a.issue_number === 5)).toBe(false); // slice-plan lookup only; the PR run-state comment is read on the PR number (#3909)
      expect(r.calls[0]?.[1]).toBe('factory/5-fix-the-bug');
      expect(plan[0]).toMatchObject({ sizeGateMode: 'stack', parkOverBudget: true });
    });

    it('does not look up the slice plan in off mode', async () => {
      const r = await sliceRun({ sizeGate: 'off' }, async () => ({ data: [] }));
      expect(r.listArgs.some(([a]: any) => a.issue_number === 5)).toBe(false); // slice-plan lookup only; the PR run-state comment is read on the PR number (#3909)
      expect(r.calls[0]?.[1]).toBe('factory/5-fix-the-bug');
    });

    describe('open factory PR adoption with the default stack (#3832)', () => {
      const openPr = () => {
        const fake = defaultOctokit() as any;
        fake.rest.pulls.list = async ({ state }: any) => ({
          data:
            state === 'open'
              ? [{ number: 77, head: { ref: 'factory/5-old-title', sha: 'abc', repo: { full_name: h.ghRepo } } }]
              : [],
        });
        return fake;
      };
      const branchFor = async (opts: Parameters<typeof shipIssue>[1], mode?: string) => {
        const { calls, setupWorktree: setup } = recordSetup();
        h.factoryConfig = { ...h.factoryConfig, sizeGate: mode === undefined ? {} : { mode } };
        const fake = openPr();
        await shipIssue(5, opts, ctx(), { setupWorktree: setup, octokit: () => fake });
        return calls[0]?.[1];
      };

      it.each([undefined, 'file', 'slice'])('adopts the open PR branch when sizeGate.mode is %s', async (mode) => {
        expect(await branchFor({}, mode)).toBe('factory/5-old-title');
      });

      it('keeps a fresh branch for an explicit --stack', async () => {
        expect(await branchFor({ sizeGate: 'stack', explicitStack: true })).toBe('factory/5-fix-the-bug');
      });

      it('keeps a fresh branch when the config says stack', async () => {
        expect(await branchFor({}, 'stack')).toBe('factory/5-fix-the-bug');
      });
    });

    it('parks before creating a worktree when the slice plan lookup throws', async () => {
      const r = await sliceRun({ sizeGate: 'stack' }, () => Promise.reject(new Error('network down')));
      expect(r.err).toBeInstanceOf(LaneParkError);
      expect(r.calls).toEqual([]);
    });
  });

  it('uses the injected octokit factory instead of the default client', async () => {
    const fake = defaultOctokit() as any;
    fake.rest.issues.get = async () => ({ data: { title: 'Injected title' } });
    const factoryCalls: unknown[][] = [];
    const branch = await shipIssue(5, {}, ctx(), { octokit: spy(factoryCalls, () => fake as never) });
    expect(factoryCalls.length).toBe(1);
    expect(branch).toBe('factory/5-injected-title');
    expect(readFileSync(paths().events, 'utf-8')).toMatch(/"type":"issue-title".*Injected title/);
  });

  it('main() routes deps.octokit to GitHub-backed commands', async () => {
    const fake = defaultOctokit() as any;
    const [fakeListCalls, factoryCalls, defaultListCalls]: unknown[][][] = [[], [], []];
    fake.rest.pulls.list = spy(fakeListCalls, async () => ({ data: [] }));
    h.octokit.rest.pulls.list = spy(defaultListCalls, async () => ({ data: [] }));
    await runMainWith({ octokit: spy(factoryCalls, () => fake as never) }, 'land', '5');

    expect(factoryCalls.length).toBeGreaterThan(0);
    expect(fakeListCalls.length).toBeGreaterThan(0);
    expect(defaultListCalls).toEqual([]);
  });

  it('uses injected resolveTimeouts, resolveSkipCI and resolveEffectiveModelPins', async () => {
    const [timeoutArgs, skipArgs, pinCalls]: unknown[][][] = [[], [], []];
    h.modelProviders = { 'pin-2064': 'anthropic' };
    const pin = { plan: undefined, planFallback: undefined, build: 'pin-2064', buildFallback: undefined, sources: {} };
    await shipIssue(5, {}, ctx(), {
      resolveTimeouts: spy(timeoutArgs, () => ({ plan: 1, build: 1, check: 1, approval: 1, tests: 1 })) as never,
      resolveSkipCI: spy(skipArgs, () => false),
      resolveEffectiveModelPins: spy(pinCalls, () => pin) as never,
    });
    expect(timeoutArgs).toContainEqual([h.factoryConfig]);
    expect(skipArgs).toContainEqual([h.factoryConfig]);
    expect(pinCalls.length).toBeGreaterThan(0);
    expect(readFileSync(paths().events, 'utf-8')).toContain('build model pinned to pin-2064');
  });

  it('uses injected loadFactoryConfigForRepo and loadRepoConfig', async () => {
    const repoValue = FactoryCore.loadRepoConfig(h.repoRoot);
    const [factoryArgs, repoArgs]: unknown[][][] = [[], []];
    await shipIssue(5, {}, ctx(), {
      loadFactoryConfigForRepo: spy(factoryArgs, () => h.factoryConfig) as never,
      loadRepoConfig: spy(repoArgs, () => repoValue) as never,
    });
    expect(factoryArgs.some((a) => /\.factory\/config\.(json|yaml)$/.test(String(a[0])))).toBe(true);
    expect(repoArgs).toContainEqual([h.repoRoot, paths().root]);
  });

  it('uses an injected loadModelsConfig and loadRoutesConfig', async () => {
    const modelsValue = { models: { 'distinctive-model-2064': {} }, tiers: {} };
    const routesValue = { 'distinctive-route-2064': {} };
    const routerArgs: any[][] = [];
    await shipIssue(5, {}, ctx(), {
      loadModelsConfig: () => modelsValue as never,
      loadRoutesConfig: () => routesValue as never,
      ModelRouter: function (...a: unknown[]) {
        routerArgs.push(a);
        return new (coreFakes.ModelRouter as any)(...a);
      } as never,
    });
    expect(routerArgs.at(-1)?.[0]).toMatchObject(modelsValue);
    expect(routerArgs.at(-1)?.[1]).toMatchObject(routesValue);
  });

  it('uses the h.octokit client injected through the shared ops fakes', async () => {
    h.octokit.rest.issues.get = async () => ({ data: { title: 'Shared client title' } });
    expect(await shipIssue(5, {}, ctx())).toBe('factory/5-shared-client-title');
  });

  it('forwards an injected shipPhase override into RunPorts instead of the default', async () => {
    const shipCalls: unknown[][] = [];
    const { seen, ctx: octx } = outcomeCtx();
    const shipPhase = spy(shipCalls, async () => ({ ...h.shipResult, prNumber: 4242 }));
    await shipIssue(5, {}, octx, { shipPhase: shipPhase as never });
    expect(shipCalls.length).toBe(1);
    expect(seen[0]).toMatchObject({ prNumber: 4242 });
  });

  it('drives the deps-builder phase doubles when the test passes no override', async () => {
    const { seen, ctx: octx } = outcomeCtx();
    const { plan, deps } = recordPhases();
    await shipIssue(5, {}, octx, deps);
    expect(plan.length).toBe(1);
    expect(seen[0]).toMatchObject({ prNumber: 99 });
  });

  it('main() forwards phase overrides to the shipIssue it runs', async () => {
    const planCalls: unknown[][] = [];
    await runMainWith({ planPhase: spy(planCalls, async () => h.planResult) as never }, 'ship', '5');
    expect(planCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('restores the default phases after main() returns', async () => {
    const shipCalls: unknown[][] = [];
    const customShip = spy(shipCalls, async () => ({ ...h.shipResult, prNumber: 4242 }));
    await runMainWith({ shipPhase: customShip as never }, 'ship', '5');
    const n = shipCalls.length;
    const { seen, ctx: octx } = outcomeCtx();
    await shipIssue(5, {}, octx);
    expect(shipCalls.length).toBe(n);
    expect(seen[0]).toMatchObject({ prNumber: 99 });
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
    const repoArgs: unknown[][] = [];
    await shipIssue(5, {}, ctx(), { loadRepoConfig: spy(repoArgs, FactoryCore.loadRepoConfig) as never });
    expect(repoArgs).toContainEqual([h.repoRoot, paths().root]);
  });

  it('keeps a claude-cli build pin on the claude route when PLAN picks codex (#1367)', async () => {
    h.modelOverrides = { build: 'claude-sonnet-5' };
    h.modelProviders = { 'claude-sonnet-5': 'anthropic' };
    h.planResult = { ok: true, route: 'codex' };
    const { plan, build, deps } = recordPhases();
    await shipIssue(5, {}, ctx(), deps);

    expect(plan.at(-1)).toMatchObject({ preferredRoute: 'claude' });
    expect(build.at(-1)).toMatchObject({ route: 'claude', modelOverride: 'claude-sonnet-5' });
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('build model pinned to claude-sonnet-5');
    expect(events).toContain('build route derived from pinned build model claude-sonnet-5 → claude');
    expect(events).not.toContain('model_override_ignored');
  });

  it('reads providers flags from .factory/config.json (no symlink needed)', async () => {
    mkdirSync(paths().root, { recursive: true });
    writeFileSync(paths().config, JSON.stringify({ version: 1, providers: { ollama: false } }));
    const results: unknown[] = [];
    const record = (...a: Parameters<typeof FactoryCore.loadRepoConfig>) => (
      results.push(FactoryCore.loadRepoConfig(...a)),
      results.at(-1)
    );
    await shipIssue(5, {}, ctx(), { loadRepoConfig: record as never });
    expect(results.at(-1)).toEqual({ version: 2, providers: { ollama: false } });
  });

  // Regression (#681): a closed issue must be refused before any resource is
  // committed — no worktree, no port lease, no model call.
  it('refuses a closed issue before any resource is committed', async () => {
    h.octokit.rest.issues.get = async () => ({ data: { title: 'Fix the bug', state: 'closed' } });

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
      .map((line) => JSON.parse(line))
      .find((event) => event.type !== 'config_source');
    expect(events).toMatchObject({ type: 'issue-title', issue: '5', msg: 'Fix the bug' });
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
    const models = () =>
      ({
        models: Object.fromEntries(
          ['triage-x', 'plan-x', 'build-y', 'checker-z'].map((id) => [id, { provider: 'anthropic' }]),
        ),
        tiers: {},
      }) as never;
    const pins = () => ({
      plan: 'plan-x',
      planFallback: undefined,
      build: 'build-y',
      buildFallback: undefined,
      sources: { plan: 'repo', build: 'repo' },
    });
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
    const { plan, deps } = recordPhases();
    await shipIssue(6, {}, ctx(), deps);
    const planCall = plan.at(-1);
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
    const { build, deps } = recordPhases();
    await shipIssue(5, {}, ctx(), deps);
    expect(build.at(-1)).toMatchObject({ route: 'codex', modelOverride: 'gpt-build', codexFallbackModel: 'gpt-build' });
  });

  it('logs standards source when a repo constitution resolves', async () => {
    h.constitutionResolve = () => ({ source: 'repo', product: 'alpha' });
    await shipIssue(5, { product: 'alpha' }, ctx());
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain('Standards from repo instruction files');
  });

  it('passes the main checkout as the constitution source', async () => {
    const resolveArgs: unknown[][] = [];
    h.constitutionResolve = spy(resolveArgs, () => null);
    await shipIssue(5, {}, ctx());
    expect(resolveArgs.length).toBe(1);
    expect(resolveArgs[0]?.[3]).toBe(h.repoRoot);
    expect(resolveArgs[0]?.[0]).not.toBe(h.repoRoot);
  });

  it('logs bundled standards source when a bundled constitution resolves', async () => {
    h.constitutionResolve = () => ({ source: 'bundled', product: 'beta' });
    await shipIssue(5, {}, ctx());
    const events = readFileSync(paths().events, 'utf-8');
    expect(events).toContain("bundled constitution 'beta'");
  });
});

describe('shipIssue review rework (#3564)', () => {
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
  const reworkClaimed = async (extra?: Record<string, unknown>) => {
    seed(extra);
    const fake = defaultOctokit() as any;
    const getArgs: unknown[][] = [];
    fake.rest.pulls.get = spy(getArgs, async () => ({
      data: { state: 'closed', head: { ref: 'factory/5-fix-the-bug' } },
    }));
    const { plan, deps } = recordPhases();
    await expect(shipIssue(5, {}, ctx(), { ...deps, octokit: () => fake })).rejects.toThrow(/PR #77 must be open/);
    expect(plan).toEqual([]);
    expect(getArgs.some(([a]: any) => a.pull_number === 77)).toBe(true);
    const saved = JSON.parse(readFileSync(join(paths().state, 'review-rework.json'), 'utf-8'));
    expect(saved.reviews[0].startedAt).toEqual(expect.any(String));
  };

  it('claims a pending record: skips PLAN, sends reviewRework on the request and marks it started', () =>
    reworkClaimed());

  it('a comment rework record skips PLAN and adopts the existing PR (#3882)', () =>
    reworkClaimed({ source: 'comment' }));

  it('runs normally when the record is already started or absent', async () => {
    seed({ startedAt: '2026-01-02T00:00:00.000Z' });
    const { plan, deps } = recordPhases();
    await shipIssue(5, {}, ctx(), deps);
    expect(plan.length).toBeGreaterThan(0);
  });
});
