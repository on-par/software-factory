import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { buildPlanPrompt, planPhase } from './plan.js';
import { StubModelExecutor } from './plan-test-helpers.js';

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
    readiness_enrich: { tier: 'boss', description: 'stub' },
    decompose: { tier: 'boss', description: 'stub' },
  },
};

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe('BLOCKED_BY claim (#2317)', () => {
  const claimBlock = '```\nIn scope:\n- Add the storage layer\nAcceptance criteria:\n- Storage merged\n```';
  const validClaim = `BLOCKED_BY: Add storage layer | Storage is missing\n${claimBlock}`;

  const runPlan = async (output: string, body = 'Add export.') => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const stub = new StubModelExecutor({ scripts: { plan: [{ output }] } });
    const router = new ModelRouter(models, routes, false, stub);
    const octokit: any = {
      rest: { issues: { get: async () => ({ data: { title: 'Add export', body } }) } },
    };
    return planPhase({
      issue: 44,
      repo: 'on-par/software-factory',
      worktree,
      specPath: join(worktree, 'issue-44.md'),
      router,
      constitution: null,
      octokit,
      log: () => {},
    });
  };

  it('returns the parsed blocker claim for a valid BLOCKED_BY output', async () => {
    const result = await runPlan(`notes\n${validClaim}`);
    expect(result.ok).toBe(false);
    expect(result.escalate).toBe('BLOCKED_BY: Add storage layer | Storage is missing');
    expect(result.blocker).toMatchObject({ title: 'Add storage layer', inScope: ['Add the storage layer'] });
  });

  it('an invalid BLOCKED_BY claim escalates and carries no blocker', async () => {
    const result = await runPlan('BLOCKED_BY: no separator here');
    expect(result.ok).toBe(false);
    expect(result.blocker).toBeUndefined();
    expect(result.escalate).toBe('invalid BLOCKED_BY claim: missing title or problem');
  });

  it('an invalid claim with an ESCALATE line keeps the ESCALATE handling', async () => {
    const result = await runPlan('BLOCKED_BY: nope\nESCALATE: which provider?');
    expect(result.blocker).toBeUndefined();
    expect(result.escalate).toBe('ESCALATE: which provider?');
  });

  it('ignores a claim that only appears in the issue body', async () => {
    const result = await runPlan('ESCALATE: which provider?', `Body\n${validClaim}`);
    expect(result.blocker).toBeUndefined();
  });

  it('the plan prompt asks for the BLOCKED_BY format', () => {
    const prompt = buildPlanPrompt({
      issue: 1,
      issueTitle: 't',
      issueBody: 'b',
      specPath: '/tmp/x.md',
      constitutionCtx: '',
    });
    expect(prompt).toContain('BLOCKED_BY:');
  });
});
