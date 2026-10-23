import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { ModelRouter } from '../router/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { writeSpec } from '../spec/index.js';
import { planPhase } from './plan.js';
import { StubModelExecutor } from './plan-test-helpers.js';
import { settlePlanRoute } from './plan-route.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub-model'] },
  failover: {
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
  },
  routingRules: {},
};

const routes: RoutesConfig = {
  version: 1,
  routes: {
    plan: { tier: 'boss', description: 'stub' },
    readiness_enrich: { tier: 'boss', description: 'stub' },
    decompose: { tier: 'boss', description: 'stub' },
  },
};

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

async function tempSpec(name: string, route: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'plan-route-test-'));
  tempDirs.add(dir);
  const specPath = join(dir, name);
  await writeSpec(specPath, { body: '# Spec\n', data: { route } });
  return specPath;
}

describe('settlePlanRoute command route (#2872)', () => {
  const base = { runnableNow: ['claude', 'codex'] as const, isCodexDisabled: false, log: () => {} };

  it('lets a pin override the planned route and rewrites the spec to command', async () => {
    const specPath = await tempSpec('a.md', 'claude');
    const route = await settlePlanRoute({ ...base, parsedRoute: 'claude', preferredRoute: 'command', specPath });
    expect(route).toBe('command');
    expect(await readFile(specPath, 'utf8')).toContain('route: command');
  });

  it('treats a planner-written command with no pin as no choice and rewrites the spec', async () => {
    const specPath = await tempSpec('b.md', 'command');
    const route = await settlePlanRoute({ ...base, parsedRoute: 'command', specPath });
    expect(route).toBe('claude');
    expect(await readFile(specPath, 'utf8')).toContain('route: claude');
  });

  it('rewrites a planner-written command even when the pin equals the fallback route', async () => {
    const specPath = await tempSpec('c.md', 'command');
    const route = await settlePlanRoute({ ...base, parsedRoute: 'command', preferredRoute: 'claude', specPath });
    expect(route).toBe('claude');
    expect(await readFile(specPath, 'utf8')).toContain('route: claude');
  });

  it('keeps a planner-written command when build_command is runnable', async () => {
    const specPath = await tempSpec('e.md', 'command');
    const route = await settlePlanRoute({
      ...base,
      runnableNow: ['claude', 'codex', 'command'],
      parsedRoute: 'command',
      specPath,
    });
    expect(route).toBe('command');
    expect(await readFile(specPath, 'utf8')).toContain('route: command');
  });

  it('keeps the planned route when it is runnable and unpinned', async () => {
    const specPath = await tempSpec('d.md', 'codex');
    expect(await settlePlanRoute({ ...base, parsedRoute: 'codex', specPath })).toBe('codex');
  });
});

const sandboxTmp = createTempDirs();
afterEach(async () => {
  await sandboxTmp.cleanup();
});

describe('planPhase command route (#2872)', () => {
  it('passes a runtime-none policy to the plan router call', async () => {
    const worktree = await sandboxTmp.make('plan-sandbox-test-');
    const sandbox: SandboxPolicy = {
      runtime: 'none',
      worktree,
      writablePaths: [worktree],
      writableFilePrefixes: [],
      allowHosts: [],
      cpuMs: 300_000,
      memMb: 4096,
    };
    let seenSandbox: SandboxPolicy | undefined;
    const stub = new StubModelExecutor({
      scripts: {
        plan: [
          {
            output: '---\nroute: codex\n---\n# Spec\n\n## Files / approach\nUpdate a scoped source file.\n',
            effect: (ctx) => {
              seenSandbox = ctx.sandbox;
            },
          },
        ],
      },
    });
    const result = await planPhase({
      issue: 3247,
      repo: 'on-par/software-factory',
      worktree,
      specPath: join(worktree, 'spec.md'),
      router: new ModelRouter(models, routes, false, stub),
      constitution: null,
      sandbox,
      enforceReadiness: false,
      octokit: {
        rest: {
          issues: { get: async () => ({ data: { title: 'Fix sandbox default', body: 'Use workspace-write' } }) },
        },
      } as any,
      log: () => {},
    });
    expect(result.ok).toBe(true);
    expect(seenSandbox).toBe(sandbox);
  });

  it.each([
    ['preferredRoute command overrides the planned route and rewrites the spec', 'claude', 'command', 'command'],
    ['a planner-written route command with no pin is no choice', 'command', undefined, 'claude'],
  ] as const)('%s', async (_name, plannerRoute, preferredRoute, expected) => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-2872.md');
    const body = `## Problem statement
Status output has an extra blank line.
## In scope
- Update packages/cli/src/status.ts and its test.
## Out of scope
- Changing output format.
## Acceptance criteria
- [ ] Status has no blank line.
## Verification
npm test`;
    const stub = new StubModelExecutor({
      scripts: {
        plan: [
          { output: `---\nroute: ${plannerRoute}\n---\n# Spec\n\n## Files / approach\nUpdate a scoped source file.\n` },
        ],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);

    const result = await planPhase({
      issue: 2872,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      router,
      constitution: null,
      octokit: { rest: { issues: { get: async () => ({ data: { title: 'Fix status output', body } }) } } } as any,
      log: () => {},
      enforceReadiness: true,
      ...(preferredRoute ? { preferredRoute } : {}),
    });

    expect(result.ok).toBe(true);
    expect(result.route).toBe(expected);
    expect(await readFile(specPath, 'utf8')).toContain(`route: ${expected}`);
  });
});

describe('planPhase planner-chosen command route (#2874)', () => {
  it('planPhase honors a planner-written route command when build_command is runnable (#2874)', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-2874.md');
    const body = `## Problem statement
Status output has an extra blank line.
## In scope
- Update packages/cli/src/status.ts and its test.
## Out of scope
- Changing output format.
## Acceptance criteria
- [ ] Status has no blank line.
## Verification
npm test`;
    const declaredModels: ModelsConfig = {
      ...models,
      models: {
        ...models.models,
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
      tiers: { boss: ['stub-model'], worker: ['my-model'] },
      harnesses: {
        'my-agent': { command: 'my-agent {model}', prompt: 'stdin', output: 'stdout', agentic: true, usage: 'none' },
      },
    };
    const declaredRoutes: RoutesConfig = {
      ...routes,
      routes: { ...routes.routes, build_command: { tier: 'worker', description: 'stub', requires: 'command' } },
    };
    const stub = new StubModelExecutor({
      scripts: {
        plan: [{ output: '---\nroute: command\n---\n# Spec\n\n## Files / approach\nUpdate a scoped source file.\n' }],
      },
    });
    const router = new ModelRouter(declaredModels, declaredRoutes, false, stub);

    const result = await planPhase({
      issue: 2874,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      router,
      constitution: null,
      octokit: { rest: { issues: { get: async () => ({ data: { title: 'Fix status output', body } }) } } } as any,
      log: () => {},
      enforceReadiness: true,
    });

    expect(result.ok).toBe(true);
    expect(result.route).toBe('command');
    expect(await readFile(specPath, 'utf8')).toContain('route: command');
  });
});
