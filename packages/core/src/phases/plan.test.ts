import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

afterEach(async () => {
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
});
