// src/checkers/design-floor.test.ts — design critic skips a review floor class A diff (#3374).

import { describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { applyReviewFloorOverrides } from '../review/floor.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { designFloorSkip, readDesignFloorChanges } from './design-floor.js';
import { DIFF_EXCLUDES, type DiffRunner, designSmellsChecker } from './design-smells.js';
import type { CheckerContext } from './index.js';

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

const routes: RoutesConfig = { version: 1, routes: { check_design: { tier: 'boss', description: 'stub' } } };

const PASS = '{"checker":"design_smells","result":"PASS","smells":[]}';
const cleanDiff = { text: 'diff --git a/x.ts b/x.ts\n+const x = 1;\n', baseRef: 'origin/main', truncated: false };

function numstatRunner(numstat: string | null): DiffRunner {
  return async (argv) => {
    if (!argv.includes('--numstat')) return { ok: true, stdout: '' };
    if (argv.includes('origin/main...HEAD')) return { ok: numstat !== null, stdout: numstat ?? '' };
    return { ok: true, stdout: '' };
  };
}

async function runWith(numstat: string | null, extra: Partial<CheckerContext> = {}) {
  const stub = new StubModelExecutor({ scripts: { check_design: [{ output: PASS }] } });
  const router = new ModelRouter(models, routes, false, stub);
  const run = vi.spyOn(router, 'run');
  const ctx: CheckerContext = { worktree: '/no/such/worktree', specPath: '/no/such/spec.md', ...extra };
  const result = await designSmellsChecker(ctx, router, undefined, {
    collectDiff: async () => cleanDiff,
    diffRunner: numstatRunner(numstat),
  });
  return { result, calls: run.mock.calls.length };
}

describe('designSmellsChecker review floor skip', () => {
  it('skips the design critic on a docs-only diff (review floor A, T22)', async () => {
    const { result, calls } = await runWith('1\t1\tdocs/guide.md\n');
    expect(result.result).toBe('SKIP');
    expect(result.details).toContain('review floor A');
    expect(result.details).toContain('docs-only');
    expect(calls).toBe(0);
  });

  it('skips the design critic on a tests-only diff (review floor A)', async () => {
    const { result, calls } = await runWith('3\t0\tpackages/core/src/a.test.ts\n2\t1\tpackages/cli/src/b.test.ts\n');
    expect(result.result).toBe('SKIP');
    expect(result.details).toContain('review floor A');
    expect(result.details).toContain('tests-only');
    expect(calls).toBe(0);
  });

  it('runs the design critic on a one-line source diff (review floor B)', async () => {
    const { result, calls } = await runWith('1\t1\tpackages/core/src/phases/build.ts\n');
    expect(result.result).toBe('PASS');
    expect(calls).toBe(1);
  });

  it('runs the design critic when the numstat read fails', async () => {
    expect((await runWith(null)).calls).toBe(1);
  });

  it('runs the design critic when a docs path hits a C rule', async () => {
    expect((await runWith('1\t1\tdocs/merge-policy.md\n')).calls).toBe(1);
  });

  it('uses ctx.reviewFloorRules when set', async () => {
    const { calls } = await runWith('1\t1\tdocs/guide.md\n', {
      reviewFloorRules: applyReviewFloorOverrides({ autoEligible: [] }),
    });
    expect(calls).toBe(1);
  });
});

describe('designFloorSkip', () => {
  it('returns null when the runner throws', async () => {
    const run: DiffRunner = async () => {
      throw new Error('boom');
    };
    expect(await designFloorSkip({ worktree: '/w', specPath: '/s' }, 'origin/main', run)).toBeNull();
  });
});

describe('readDesignFloorChanges', () => {
  it('reads committed and uncommitted numstat with the diff excludes, null on failure', async () => {
    const seen: string[][] = [];
    const run: DiffRunner = async (argv) => {
      seen.push([...argv]);
      return { ok: true, stdout: '1\t2\ta.ts\n' };
    };
    expect(await readDesignFloorChanges('/w', 'origin/main', run)).toEqual([
      { path: 'a.ts', added: 1, removed: 2 },
      { path: 'a.ts', added: 1, removed: 2 },
    ]);
    expect(seen[0]).toEqual(
      expect.arrayContaining(['--numstat', '--no-renames', 'origin/main...HEAD', ...DIFF_EXCLUDES]),
    );
    expect(seen[1]).toEqual(expect.arrayContaining(['--numstat', '--no-renames', 'HEAD', ...DIFF_EXCLUDES]));
    expect(await readDesignFloorChanges('/w', 'origin/main', async () => ({ ok: false, stdout: '' }))).toBeNull();
  });
});
