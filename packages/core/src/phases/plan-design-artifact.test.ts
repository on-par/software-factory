import { workKeyFromIssue } from '../work/work-key.js';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { readSpec } from '../spec/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { buildDesignArtifactRetryPrompt, MAX_DESIGN_ARTIFACT_RETRIES, planPhase } from './plan.js';
import {
  buildDesignBlockRepairPrompt,
  DESIGN_ARTIFACT_LOSS,
  designArtifactInvalidMessage,
  extractDesignBlock,
} from './plan-design-retry.js';

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

const withDesign = (designYaml: string) =>
  `---\nroute: codex\n${designYaml}  openQuestions: []\n---\n# Spec\n\n## Files / approach\n\nUpdate packages/core/src/foo.ts.\n`;

async function runPlan(designYaml: string | string[]) {
  const yamls = Array.isArray(designYaml) ? designYaml : [designYaml];
  return runPlanOutputs(yamls.map(withDesign));
}

async function runPlanOutputs(outputs: string[]) {
  const worktree = await mkdtemp(join(tmpdir(), 'plan-design-artifact-test-'));
  tempDirs.add(worktree);
  const specPath = join(worktree, 'issue-2802.md');
  const stub = new StubModelExecutor({
    scripts: { plan: outputs.map((output) => ({ output })) },
  });
  const router = new ModelRouter(models, routes, false, stub);
  const octokit: any = {
    rest: { issues: { get: async () => ({ data: { title: 'Design artifact', body: 'Body.' } }) } },
  };
  const logs: Array<{ type: string; msg: string }> = [];

  const result = await planPhase({
    issue: workKeyFromIssue(2802),
    repo: 'on-par/software-factory',
    worktree,
    specPath,
    router,
    constitution: null,
    octokit,
    log: (type, msg) => logs.push({ type, msg }),
  });
  return { result, logs, stub, specPath, worktree };
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
    const unfixable = `${validDesignYaml.replace('  riskBlastRadius: Nothing breaks.\n', '')}${objectEdgeInputs}`;
    const { result, logs } = await runPlan([unfixable, unfixable, unfixable]);

    expect(result.designArtifact).toBeNull();
    const invalid = logs.filter((l) => l.type === 'design_artifact_invalid');
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.msg).toContain('riskBlastRadius');
    const coerced = logs.filter((l) => l.type === 'design_artifact_coerced');
    expect(coerced.some((l) => l.msg.includes('edgeInputs[0]'))).toBe(true);
  });
});

describe('design artifact retry (#2803)', () => {
  const missingRisk = validDesignYaml.replace('  riskBlastRadius: Nothing breaks.\n', '');
  const planCalls = (stub: StubModelExecutor) => stub.calls.filter((c) => c.task === 'plan');

  it('re-prompts once with the validation errors and uses the valid retry artifact without design_artifact_invalid (#2803)', async () => {
    const { result, logs, stub } = await runPlan([missingRisk, validDesignYaml]);

    const calls = planCalls(stub);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toContain('riskBlastRadius');
    expect(result.ok).toBe(true);
    expect(result.designArtifact).not.toBeNull();
    expect(logs.some((l) => l.type === 'design_artifact_invalid')).toBe(false);
    expect(logs.filter((l) => l.type === 'design_artifact_emitted')).toHaveLength(1);
  });

  it('re-prompts with the no design block error when the spec has no design block (#2803)', async () => {
    const { result, logs, stub } = await runPlanOutputs([
      '---\nroute: codex\n---\n# Spec\n',
      withDesign(validDesignYaml),
    ]);

    const calls = planCalls(stub);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toContain('no design block in spec frontmatter');
    expect(result.designArtifact).not.toBeNull();
    expect(logs.some((l) => l.type === 'design_artifact_invalid')).toBe(false);
  });

  it('stops after 2 re-prompts and continues without the artifact (#2803)', async () => {
    const { result, logs, stub } = await runPlan([missingRisk, missingRisk, missingRisk, missingRisk]);

    expect(planCalls(stub)).toHaveLength(3);
    expect(result.ok).toBe(true);
    expect(result.designArtifact).toBeNull();
    expect(logs.filter((l) => l.type === 'design_artifact_invalid')).toHaveLength(1);
  });

  it('logs design_artifact_invalid once after exhausting retries, with the attempt count and what the run loses (#2804)', async () => {
    const { result, logs, stub } = await runPlan([missingRisk, missingRisk, missingRisk, missingRisk]);

    expect(planCalls(stub)).toHaveLength(MAX_DESIGN_ARTIFACT_RETRIES + 1);
    expect(result.ok).toBe(true);
    expect(result.designArtifact).toBeNull();
    const invalid = logs.filter((l) => l.type === 'design_artifact_invalid');
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.msg).toContain('riskBlastRadius');
    expect(invalid[0]?.msg).toContain(`after ${MAX_DESIGN_ARTIFACT_RETRIES + 1} attempt(s)`);
    expect(invalid[0]?.msg).toContain(DESIGN_ARTIFACT_LOSS);
    expect(invalid[0]?.msg).toMatch(/lane guard/);
    expect(invalid[0]?.msg).toMatch(/Risk \/ blast radius/);
  });

  it('designArtifactInvalidMessage keeps the legacy prefix and names every error and the loss (#2804)', () => {
    const msg = designArtifactInvalidMessage(['err one', 'err two'], 3);
    expect(msg.startsWith('spec frontmatter has no valid design artifact')).toBe(true);
    expect(msg).toContain('err one; err two');
    expect(msg).toContain('after 3 attempt(s)');
    expect(msg).toContain(DESIGN_ARTIFACT_LOSS);
  });

  it('buildDesignArtifactRetryPrompt includes the base prompt and every error (#2803)', () => {
    const prompt = buildDesignArtifactRetryPrompt('BASE PROMPT', ['err one', 'err two']);
    expect(prompt).toContain('BASE PROMPT');
    expect(prompt).toContain('- err one');
    expect(prompt).toContain('- err two');
  });
});

describe('blocked plan notes', () => {
  it('escalates a blocked no-change note before exhausting design retries', async () => {
    const blockedSpec = [
      '---',
      'route: codex',
      '---',
      'Blocked: sandbox policy prevents writing the required file outside this worktree:',
      '',
      '`/Users/dev/repos/example/app/.factory/plans/issue-844.md`',
      '',
      'No files were changed.',
      '',
    ].join('\n');
    const { result, logs, stub } = await runPlanOutputs([blockedSpec]);

    expect(result.ok).toBe(false);
    expect(result.escalate).toBe('PLAN returned a blocked/no-change note instead of a frozen spec');
    expect(logs.some((entry) => entry.type === 'escalate' && entry.msg === result.escalate)).toBe(true);
    expect(logs.some((entry) => entry.type === 'design_artifact_invalid')).toBe(false);
    expect(stub.calls.filter((call) => call.task === 'plan')).toHaveLength(1);
  });
});

describe('design block repair (#4289)', () => {
  const body = '# Spec\n\n## Files / approach\n\nUpdate packages/core/src/foo.ts.\n';
  const noDesignSpec = `---\nroute: codex\n---\n${body}`;
  const repairReply = `${validDesignYaml}  openQuestions: []\n`;
  const planCalls = (stub: StubModelExecutor) => stub.calls.filter((c) => c.task === 'plan');

  it('repairs a missing design block without re-planning', async () => {
    const { result, logs, stub, specPath, worktree } = await runPlanOutputs([noDesignSpec, repairReply]);

    expect(planCalls(stub)).toHaveLength(2);
    expect(existsSync(join(worktree, '.archive'))).toBe(false);
    const spec = await readSpec(specPath);
    expect(spec.body.trim()).toBe(body.trim());
    expect(spec.route).toBe('codex');
    expect(result.designArtifact).not.toBeNull();
    expect(logs.some((l) => l.msg.startsWith('design artifact repaired'))).toBe(true);
    expect(logs.some((l) => l.msg.includes('re-prompting planner'))).toBe(false);
  });

  it('repair prompt asks for the design block only', async () => {
    const { stub } = await runPlanOutputs([noDesignSpec, repairReply]);

    const prompt = planCalls(stub)[1]?.prompt ?? '';
    expect(prompt).toContain('no design block in spec frontmatter');
    expect(prompt).toContain('ONLY the design: YAML block');
    expect(prompt).not.toContain('Write the complete spec again');

    const direct = buildDesignBlockRepairPrompt('BASE', ['err one']);
    expect(direct.startsWith('BASE')).toBe(true);
    expect(direct).toContain('- err one');
    expect(direct).not.toContain('Write the complete spec again');

    expect(extractDesignBlock(`\`\`\`yaml\n${validDesignYaml}\`\`\``)).toMatchObject({
      restatedProblem: 'The problem statement, restated.',
    });
    expect(extractDesignBlock(validDesignYaml)).toMatchObject({ riskBlastRadius: 'Nothing breaks.' });
    expect(extractDesignBlock(withDesign(validDesignYaml))).toMatchObject({ riskBlastRadius: 'Nothing breaks.' });
    expect(extractDesignBlock('not yaml at all: [')).toBeUndefined();
  });

  it('falls back to the existing loss message when repair keeps failing', async () => {
    const { result, logs, stub } = await runPlanOutputs([noDesignSpec, 'not yaml at all: [', 'not yaml at all: [']);

    expect(planCalls(stub)).toHaveLength(1 + MAX_DESIGN_ARTIFACT_RETRIES);
    expect(result.designArtifact).toBeNull();
    expect(result.ok).toBe(true);
    const invalid = logs.filter((l) => l.type === 'design_artifact_invalid');
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.msg).toContain(DESIGN_ARTIFACT_LOSS);
    expect(invalid[0]?.msg).toContain(`after ${MAX_DESIGN_ARTIFACT_RETRIES + 1} attempt(s)`);
  });

  it('empty or blocked specs keep the current retry path', async () => {
    const { logs, stub, worktree } = await runPlanOutputs([
      '---\nroute: codex\n---\n# Spec\n',
      withDesign(validDesignYaml),
    ]);

    expect(planCalls(stub)[1]?.prompt).toContain('Write the complete spec again');
    expect(logs.some((l) => l.msg.includes('re-prompting planner'))).toBe(true);
    expect(existsSync(join(worktree, '.archive'))).toBe(true);

    const blocked = await runPlanOutputs([
      '---\nroute: codex\n---\nBlocked: sandbox policy prevents writing.\n\nNo files were changed.\n',
    ]);
    expect(planCalls(blocked.stub)).toHaveLength(1);
    expect(blocked.result.ok).toBe(false);
    expect(blocked.result.escalate).toBe('PLAN returned a blocked/no-change note instead of a frozen spec');
  });
});
