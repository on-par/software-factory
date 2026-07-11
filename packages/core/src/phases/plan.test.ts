import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ConstitutionLoader } from '../constitutions/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { buildPlanPrompt, planPhase } from './plan.js';

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
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const routes: RoutesConfig = {
  version: 1,
  routes: {
    plan: { tier: 'boss', description: 'stub' },
  },
};

const tempDirs = new Set<string>();
let prevFactoryCodex: string | undefined;

beforeEach(() => {
  prevFactoryCodex = process.env.FACTORY_CODEX;
  delete process.env.FACTORY_CODEX;
});

afterEach(async () => {
  if (prevFactoryCodex === undefined) delete process.env.FACTORY_CODEX;
  else process.env.FACTORY_CODEX = prevFactoryCodex;
  await Promise.all([...tempDirs].map(dir => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe('buildPlanPrompt', () => {
  it('contains the issue fields, target spec path, and route template marker', () => {
    const prompt = buildPlanPrompt({
      issue: 36,
      issueTitle: 'Add eval runner',
      issueBody: 'Measure the current prompt.',
      specPath: '/tmp/spec.md',
      constitutionCtx: '',
    });

    expect(prompt).toContain('## Issue #36: Add eval runner');
    expect(prompt).toContain('Measure the current prompt.');
    expect(prompt).toContain('Write EXACTLY ONE file, at /tmp/spec.md');
    expect(prompt).toContain('route: codex');
  });
});

describe('planPhase', () => {
  it('passes timeoutSeconds through to the router', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-36.md');
    let captured: number | undefined;
    const stub = new StubModelExecutor({
      scripts: {
        plan: [{
          output: '---\nroute: codex\n---\n# Spec\n',
          effect: (ctx) => { captured = ctx.timeout; },
        }],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);
    const octokit: any = {
      rest: {
        issues: {
          get: async () => ({ data: { title: 'Add eval runner', body: 'Measure the current prompt.' } }),
        },
      },
    };

    await planPhase({
      issue: 36,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      router,
      constitutionLoader: new ConstitutionLoader(),
      octokit,
      log: () => {},
      timeoutSeconds: 900,
    });

    expect(captured).toBe(900);
  });

  it('parses a quoted codex route from frontmatter', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-36.md');
    const stub = new StubModelExecutor({
      scripts: {
        plan: [{
          output: '---\nroute: "codex"\n---\n# Spec\n',
        }],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);
    const octokit: any = {
      rest: {
        issues: {
          get: async () => ({ data: { title: 'Add eval runner', body: 'Measure the current prompt.' } }),
        },
      },
    };

    const result = await planPhase({
      issue: 36,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      router,
      constitutionLoader: new ConstitutionLoader(),
      octokit,
      log: () => {},
    });

    expect(result.route).toBe('codex');
  });

  it('trims incidental whitespace inside a quoted route value', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-37.md');
    const stub = new StubModelExecutor({
      scripts: {
        plan: [{
          output: '---\nroute: "codex "\n---\n# Spec\n',
        }],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);
    const octokit: any = {
      rest: {
        issues: {
          get: async () => ({ data: { title: 'Add eval runner', body: 'Measure the current prompt.' } }),
        },
      },
    };

    const result = await planPhase({
      issue: 37,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      router,
      constitutionLoader: new ConstitutionLoader(),
      octokit,
      log: () => {},
    });

    expect(result.route).toBe('codex');
  });

  describe('FACTORY_CODEX kill-switch', () => {
    it('forces route to claude and logs a warn when FACTORY_CODEX=0', async () => {
      process.env.FACTORY_CODEX = '0';

      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-79.md');
      const stub = new StubModelExecutor({
        scripts: {
          plan: [{
            output: '---\nroute: codex\n---\n# Spec\n',
          }],
        },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const octokit: any = {
        rest: {
          issues: {
            get: async () => ({ data: { title: 'Add kill-switch', body: 'Add FACTORY_CODEX=0.' } }),
          },
        },
      };
      const logs: Array<{ type: string; msg: string }> = [];

      const result = await planPhase({
        issue: 79,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitutionLoader: new ConstitutionLoader(),
        octokit,
        log: (type, msg) => { logs.push({ type, msg }); },
      });

      expect(result.route).toBe('claude');
      expect(logs).toContainEqual({ type: 'warn', msg: 'codex unavailable — falling back to claude' });

      const persisted = await readFile(specPath, 'utf-8');
      expect(persisted).toContain('route: claude');
      expect(persisted).not.toContain('route: codex');
    });

    it('keeps route codex when FACTORY_CODEX is unset', async () => {
      delete process.env.FACTORY_CODEX;

      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-79.md');
      const stub = new StubModelExecutor({
        scripts: {
          plan: [{
            output: '---\nroute: codex\n---\n# Spec\n',
          }],
        },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const octokit: any = {
        rest: {
          issues: {
            get: async () => ({ data: { title: 'Add kill-switch', body: 'Add FACTORY_CODEX=0.' } }),
          },
        },
      };

      const result = await planPhase({
        issue: 79,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitutionLoader: new ConstitutionLoader(),
        octokit,
        log: () => {},
      });

      expect(result.route).toBe('codex');
    });
  });
});
