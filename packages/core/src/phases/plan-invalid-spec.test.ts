import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { parseDesignArtifact } from '../design/index.js';
import { publishParkComment } from '../run/park-comment.js';
import { runPlanOutputs } from './plan-test-helpers.js';

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

describe('PLAN with no valid design artifact (#3270)', () => {
  it('parks an invalid plan instead of building when the design is missing and the spec has no implementation (#3181 on 10/19)', async () => {
    const blockedNote =
      '---\nroute: codex\n---\nBlocked-build note: the #3175 schema module is not in this checkout.\n';
    const { result, logs, stub } = await runPlanOutputs([blockedNote], 424, models, routes, tempDirs);
    expect(result).toMatchObject({ ok: false, designArtifact: null });
    expect(result.escalate).toMatch(/^invalid plan:.*after 3 attempt\(s\).*no design block in spec frontmatter/);
    expect(stub.calls.filter((call) => call.task === 'plan')).toHaveLength(3);
    expect(logs.some((l) => l.type === 'escalate' && l.msg === result.escalate)).toBe(true);
    expect(logs.some((entry) => entry.msg.includes('Plan complete'))).toBe(false);
    expect(logs.filter((entry) => entry.type === 'design_artifact_invalid')).toHaveLength(0);
  });

  it('continues with an implementation section despite a missing design artifact', async () => {
    const output = '---\nroute: codex\n---\n# Spec\n\n## Files / approach\nUpdate packages/core/src/phases/plan.ts.\n';
    const { result, logs, stub, specPath } = await runPlanOutputs([output], 4241, models, routes, tempDirs);
    const invalid = logs.filter((entry) => entry.type === 'design_artifact_invalid');
    expect(result).toMatchObject({ ok: true, designArtifact: null });
    expect(stub.calls.filter((call) => call.task === 'plan')).toHaveLength(3);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.msg).toMatch(/after 3 attempt.*BUILD gets no design grounding/);
    expect(existsSync(`${specPath.replace(/\.md$/, '')}.design.json`)).toBe(false);
  });

  it('parks an invalid plan when Files / approach contains only TBD', async () => {
    const output = '---\nroute: codex\n---\n# Spec\n\n## Files / approach\n- **TBD**.\n';
    const { result, logs, stub } = await runPlanOutputs([output], 4242, models, routes, tempDirs);
    expect(result).toMatchObject({ ok: false, designArtifact: null });
    expect(result.escalate).toMatch(/^invalid plan:/);
    expect(stub.calls.filter((call) => call.task === 'plan')).toHaveLength(3);
    expect(logs.filter((entry) => entry.type === 'design_artifact_invalid')).toHaveLength(0);
  });

  it('parks an invalid plan and publishes only its first three validation errors', async () => {
    const output = '---\nroute: codex\ndesign: {}\n---\n# Spec\n';
    const expectedErrors = parseDesignArtifact({ route: 'codex', design: {} }).errors;
    expect(expectedErrors.length).toBeGreaterThan(3);
    const { result, octokit, worktree } = await runPlanOutputs([output], 4243, models, routes, tempDirs);
    const firstThree = expectedErrors.slice(0, 3);
    const fourth = expectedErrors[3]!;
    expect(result).toMatchObject({ ok: false, designArtifact: null });
    expect(result.escalate).toContain(firstThree.join('; '));
    expect(result.escalate).not.toContain(fourth);
    let postedBody = '';
    octokit.rest.issues.createComment = async ({ body }: { body: string }) => {
      postedBody = body;
      return { data: { id: 9 } };
    };
    await publishParkComment({
      octokit,
      repo: 'on-par/software-factory',
      worktree,
      readHead: async () => 'head-sha',
      input: {
        issue: 4243,
        reason: 'escalate',
        message: `plan escalated: ${result.escalate}`,
        runId: 'run-4243',
        branch: 'factory/issue-4243',
      },
    });
    expect(postedBody).toContain('plan escalated: invalid plan:');
    expect(postedBody).toContain(firstThree.join('; '));
    expect(postedBody).not.toContain(fourth);
  });
});
