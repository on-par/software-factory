import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { planPhase } from './plan.js';

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

const validDesignYaml = `design:
  restatedProblem: The problem statement, restated.
  approach:
    chosen: Do the thing.
    rejected:
      - option: Alt approach
        reason: Worse.
  interfacesTouched:
    - packages/core/src/foo.ts
  behaviorContract:
    - Foo now does bar.
  verificationPlan:
    - command: npm test
      passWhen: tests pass
  riskBlastRadius: Nothing breaks.
`;

const objectEdgeInputs = `  edgeInputs:
    - input: empty config
      reason: falls through to default
    - 'a plain string'
`;

async function runPlan(designYaml: string) {
  const worktree = await mkdtemp(join(tmpdir(), 'plan-design-artifact-test-'));
  tempDirs.add(worktree);
  const specPath = join(worktree, 'issue-2802.md');
  const stub = new StubModelExecutor({
    scripts: { plan: [{ output: `---\nroute: codex\n${designYaml}  openQuestions: []\n---\n# Spec\n` }] },
  });
  const router = new ModelRouter(models, routes, false, stub);
  const octokit: any = {
    rest: { issues: { get: async () => ({ data: { title: 'Design artifact', body: 'Body.' } }) } },
  };
  const logs: Array<{ type: string; msg: string }> = [];

  const result = await planPhase({
    issue: 2802,
    repo: 'on-par/software-factory',
    worktree,
    specPath,
    router,
    constitution: null,
    octokit,
    log: (type, msg) => logs.push({ type, msg }),
  });
  return { result, logs };
}

describe('design artifact edgeInputs coercion (#2802)', () => {
  it('coerces a multi-key object edgeInputs entry and accepts the artifact without design_artifact_invalid (#2802)', async () => {
    const { result, logs } = await runPlan(`${validDesignYaml}${objectEdgeInputs}`);

    expect(result.designArtifact).not.toBeNull();
    expect(result.designArtifact?.edgeInputs?.[0]).toBe(
      JSON.stringify({ input: 'empty config', reason: 'falls through to default' }),
    );
    expect(result.designArtifact?.edgeInputs?.[1]).toBe('a plain string');
    expect(logs.some((l) => l.type === 'design_artifact_invalid')).toBe(false);
    const coerced = logs.filter((l) => l.type === 'design_artifact_coerced');
    expect(coerced).toHaveLength(1);
    expect(coerced[0]?.msg).toContain('edgeInputs[0]');
    expect(logs.some((l) => l.type === 'design_artifact_emitted')).toBe(true);
  });

  it('still logs design_artifact_invalid when the artifact is unfixable despite a coerced edgeInputs entry (#2802)', async () => {
    const { result, logs } = await runPlan(
      `${validDesignYaml.replace('  riskBlastRadius: Nothing breaks.\n', '')}${objectEdgeInputs}`,
    );

    expect(result.designArtifact).toBeNull();
    const invalid = logs.filter((l) => l.type === 'design_artifact_invalid');
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.msg).toContain('riskBlastRadius');
    const coerced = logs.filter((l) => l.type === 'design_artifact_coerced');
    expect(coerced.some((l) => l.msg.includes('edgeInputs[0]'))).toBe(true);
  });
});
