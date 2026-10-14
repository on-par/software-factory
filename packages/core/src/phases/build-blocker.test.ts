import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { buildClaudePrompt, buildCommitOnlyPrompt, buildLocalSmallPrompt, buildPhase } from './build.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-worker': {
      provider: 'custom',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { worker: ['stub-worker'] },
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
  routes: { build_claude: { tier: 'worker', description: 'stub' } },
};

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe('buildPhase blocker claim (#2317)', () => {
  const claimOutput =
    'progress\nBLOCKED_BY: Add storage layer | Storage is missing\n```\nIn scope:\n- Add storage\nAcceptance criteria:\n- Storage merged\n```\n';

  const runBuild = async (output: string, extra: { disablePublish?: boolean; run?: any } = {}) => {
    const worktree = await mkdtemp(join(tmpdir(), 'build-phase-test-'));
    tempDirs.add(worktree);
    const stub = new StubModelExecutor({ scripts: { build_claude: [{ output }] } });
    const router = new ModelRouter(models, routes, false, stub);
    const logs: Array<{ type: string; msg: string }> = [];
    const result = await buildPhase({
      issue: 90,
      repo: 'on-par/software-factory',
      worktree,
      specPath: join(worktree, 'issue-90.md'),
      branch: 'ship-it/90-blocked',
      route: 'claude',
      router,
      constitution: null,
      log: (type, msg) => {
        logs.push({ type, msg });
      },
      ...extra,
    });
    return { result, logs };
  };

  it('buildPhase blocker claim pushes the branch and returns the claim', async () => {
    const run = vi.fn(async () => ({ stdout: '' }));
    const { result } = await runBuild(claimOutput, { run });
    expect(result.ok).toBe(false);
    expect(result.blocker).toMatchObject({ title: 'Add storage layer' });
    expect(result.escalate).toBe('BLOCKED_BY: Add storage layer | Storage is missing');
    expect(run).toHaveBeenCalledWith(expect.stringContaining('git push -u origin'), expect.anything());
  });

  it('logs a warn and still returns the blocker when the push fails', async () => {
    const run = vi.fn(async () => {
      throw new Error('no remote');
    });
    const { result, logs } = await runBuild(claimOutput, { run });
    expect(result.blocker).toBeDefined();
    expect(logs).toContainEqual({ type: 'warn', msg: 'blocker park: push of ship-it/90-blocked failed: no remote' });
  });

  it('reports a non-Error push failure', async () => {
    const run = vi.fn(async () => {
      throw 'boom';
    });
    const { logs } = await runBuild(claimOutput, { run });
    expect(logs).toContainEqual({ type: 'warn', msg: 'blocker park: push of ship-it/90-blocked failed: boom' });
  });

  it('skips the push when publishing is disabled', async () => {
    const run = vi.fn(async () => ({ stdout: '' }));
    const { result } = await runBuild(claimOutput, { run, disablePublish: true });
    expect(result.blocker).toBeDefined();
    expect(run).not.toHaveBeenCalled();
  });

  it('an invalid claim escalates without a blocker or push', async () => {
    const run = vi.fn(async () => ({ stdout: '' }));
    const { result } = await runBuild('BLOCKED_BY: no separator', { run });
    expect(result.ok).toBe(false);
    expect(result.blocker).toBeUndefined();
    expect(result.escalate).toBe('invalid BLOCKED_BY claim: missing title or problem');
    expect(run).not.toHaveBeenCalled();
  });

  it('an invalid claim with an ESCALATE line keeps the ESCALATE handling', async () => {
    const { result } = await runBuild('BLOCKED_BY: x\nESCALATE: why?');
    expect(result.blocker).toBeUndefined();
    expect(result.escalate).toBe('ESCALATE: why?');
  });

  it('all build prompts carry the BLOCKED_BY rule', () => {
    const base = { issue: 1, specPath: '/s.md', constitutionCtx: '', spec: 'x' };
    expect(buildCommitOnlyPrompt(base)).toContain('BLOCKED_BY:');
    expect(buildClaudePrompt({ ...base, branch: 'b' })).toContain('BLOCKED_BY:');
    expect(buildLocalSmallPrompt({ issue: 1, branch: 'b', spec: 'x' })).toContain('BLOCKED_BY:');
  });
});
