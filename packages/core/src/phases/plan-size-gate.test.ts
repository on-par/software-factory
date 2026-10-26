import { workKeyFromIssue } from '../work/work-key.js';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { planPhase } from './plan.js';
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

const tempDirs = createTempDirs();

afterEach(() => tempDirs.cleanup());

describe('size gate measures planned code size, not criteria count (#3350)', () => {
  const designYaml = (types: number, files: number) => `design:
  restatedProblem: Cohesive change.
  approach:
    chosen: Do it.
    rejected: []
  interfacesTouched:
    - packages/a.ts
  targetTypes:
${Array.from({ length: types }, (_, i) => `    - name: Type${i}\n      file: packages/m${i % files}.ts\n      kind: changed`).join('\n')}
  signatures: []
  callGraph: []
  behaviorContract:
    - One thing changes.
  verificationPlan:
    - command: npm test
      passWhen: tests pass
  riskBlastRadius: Small.
  openQuestions: []
`;
  const planOf = (yaml: string) => [{ output: `---\nroute: codex\n${yaml}---\n# Spec\n` }];
  const bigBody = `## Problem statement
A cohesive change written with many bullets.

## In scope
${Array.from({ length: 7 }, (_, i) => `- Item ${i + 1}`).join('\n')}

## Out of scope
Everything else.

## Acceptance criteria
${Array.from({ length: 10 }, (_, i) => `- [ ] Criterion ${i + 1}`).join('\n')}

## Verification
npm run test`;
  const decomposition = JSON.stringify({
    epic: { title: 'Epic', why: 'why', doneWhen: ['done'], children: ['Story 1'] },
    stories: [
      {
        title: 'Story 1',
        role: 'operator',
        want: 'thing works',
        soThat: 'value',
        problemStatement: 'Problem',
        inScope: ['Scope'],
        outOfScope: ['Other'],
        acceptanceCriteria: [{ name: 'ac', given: [], when: ['run'], then: ['works'] }],
        verification: [{ command: 'npm test', passWhen: 'passes' }],
        tracesTo: ['INT-PROBLEM-01'],
      },
    ],
  });

  async function run(opts: {
    yaml: string;
    mode?: 'file' | 'slice';
    sizeBudget?: { tokenBudget: number; maxFiles: number };
    decomposition?: string;
    state?: string;
  }) {
    const worktree = await tempDirs.make('plan-phase-test-');
    const stub = new StubModelExecutor({
      scripts: { plan: planOf(opts.yaml), decompose: [{ output: opts.decomposition ?? decomposition }] },
    });
    const router = new ModelRouter(models, routes, false, stub);
    const createComment = vi.fn().mockResolvedValue({ data: { id: 9999 } });
    const create = vi.fn().mockResolvedValue({ data: { number: 902, id: 9902 } });
    const logs: Array<{ type: string; msg: string }> = [];
    const result = await planPhase({
      issue: workKeyFromIssue(3350),
      repo: 'on-par/software-factory',
      worktree,
      specPath: join(worktree, 'issue-3350.md'),
      router,
      constitution: null,
      octokit: {
        rest: {
          users: { getAuthenticated: async () => ({ data: { id: 42 } }) },
          issues: {
            get: async () => ({ data: { state: opts.state, title: 'Cohesive change', body: bigBody } }),
            listComments: async () => ({ data: [] }),
            createComment,
            create,
            update: vi.fn(),
            addLabels: vi.fn().mockResolvedValue({}),
          },
        },
        request: vi.fn().mockResolvedValue({ data: [] }),
      } as any,
      log: (type: any, msg: any) => logs.push({ type, msg }),
      sizeGateMode: opts.mode ?? 'file',
      sizeBudget: opts.sizeBudget,
    });
    return { result, stub, logs, createComment, create };
  }

  it.each(['file', 'slice'] as const)(
    'does not slice a many-AC issue whose plan touches three files (%s mode)',
    async (mode) => {
      const { result, stub, logs, createComment, create } = await run({ yaml: designYaml(3, 3), mode });

      expect(result.ok).toBe(true);
      expect(stub.calls.map((call) => call.task)).toEqual(['plan']);
      expect(createComment).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(logs.map((l) => l.type)).toContain('size_hint');
      expect(logs.map((l) => l.type)).not.toContain('size-gate-sliced');
    },
  );

  it('splits a plan whose token estimate exceeds sizeGate.tokenBudget and logs the estimate and budget', async () => {
    const { result, stub, logs } = await run({
      yaml: designYaml(4, 4),
      sizeBudget: { tokenBudget: 10, maxFiles: 12 },
    });

    expect(stub.calls.map((call) => call.task)).toEqual(['plan', 'decompose']);
    expect(result.ok).toBe(false);
    expect(result.decomposed).toEqual({ childIssues: [902] });
    expect(result.escalate).toMatch(/tokens.*budget 10/);
    expect(logs.find((l) => l.type === 'size-gate-decomposed')?.msg).toMatch(/tokens.*budget 10/);
  });

  it.each(['file', 'slice'] as const)(
    'keeps a cohesive over-budget issue whole and logs size_gate_cohesive (%s mode)',
    async (mode) => {
      const parsed = JSON.parse(decomposition);
      const story = { ...parsed.stories[0], filesLikelyTouched: ['src/a.ts', 'src/b.ts'] };
      parsed.stories = [story, { ...story, title: 'Story 2' }];
      parsed.epic.children = ['Story 1', 'Story 2'];
      const { result, stub, logs, createComment, create } = await run({
        yaml: designYaml(4, 4),
        mode,
        sizeBudget: { tokenBudget: 10, maxFiles: 12 },
        decomposition: JSON.stringify(parsed),
      });

      expect(result.ok).toBe(true);
      expect(stub.calls.map((call) => call.task)).toEqual(['plan', 'decompose']);
      expect(createComment).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(result.decomposed).toBeUndefined();
      expect(result.sliced).toBeUndefined();
      expect(logs.map((l) => l.type)).toContain('size_gate_cohesive');
    },
  );

  it('parks with "already closed" and posts nothing when the file-mode post-plan gate hits a closed issue (#728)', async () => {
    const { result, logs, createComment, create } = await run({
      yaml: designYaml(4, 4),
      sizeBudget: { tokenBudget: 10, maxFiles: 12 },
      state: 'closed',
    });

    expect(result.ok).toBe(false);
    expect(result.escalate).toMatch(/already closed/);
    expect(result.decomposed).toBeUndefined();
    expect(createComment).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(logs.map((l) => l.type)).toEqual(expect.arrayContaining(['decompose_skipped', 'size-gate-escalated']));
  });

  it('does not split an under-budget plan with more than 6 target types', async () => {
    const { result, stub } = await run({ yaml: designYaml(9, 5) });

    expect(result.ok).toBe(true);
    expect(stub.calls.map((call) => call.task)).toEqual(['plan']);
  });
});
