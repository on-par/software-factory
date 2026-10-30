import { workKeyFromIssue } from '../work/work-key.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import type { SlicePlan } from '../readiness/slice-plan.js';
import type { SlicePlanStore } from '../readiness/slice-plan-store.js';
import { WorkSourceRegistry } from '../work/index.js';
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
        acceptanceCriteria: [
          {
            name: 'ac',
            given: [],
            when: ['run'],
            then: ['works'],
            tracesTo: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'],
          },
        ],
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

  describe('a brief source with a slice-plan store (#3813)', () => {
    const slicerOutput = JSON.stringify({
      epic: { title: 'Epic', why: 'why', doneWhen: ['done'], children: ['Story 1', 'Story 2'] },
      stories: [1, 2].map((n) => ({
        title: `Story ${n}`,
        role: 'operator',
        want: `thing ${n} works`,
        soThat: 'value',
        problemStatement: `Problem ${n}`,
        inScope: [`scope ${n}`],
        outOfScope: ['other'],
        acceptanceCriteria: [{ name: `ac ${n}`, given: [], when: ['run'], then: ['works'] }],
        verification: [{ command: 'npm test', passWhen: 'passes' }],
        filesLikelyTouched: [`src/s${n}.ts`, `src/s${n}.test.ts`],
        tracesTo: ['INT-PROBLEM-01'],
      })),
    });

    async function runBrief(opts: { files: number; store?: SlicePlanStore; mode: 'file' | 'stack' }) {
      const worktree = await tempDirs.make('plan-phase-test-');
      const stub = new StubModelExecutor({
        scripts: {
          plan: [{ output: `---\nroute: codex\n${designYaml(opts.files, opts.files)}---\n# Spec\n` }],
          decompose: [{ output: slicerOutput }],
        },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const createComment = vi.fn().mockResolvedValue({ data: { id: 9999 } });
      const workSources = new WorkSourceRegistry().register({
        kind: 'local-brief',
        resolve: async () => ({
          id: 'local-brief:1',
          kind: 'local-brief',
          title: 'Big brief',
          brief: 'Do many things.',
          acceptanceCriteria: [],
        }),
      });
      const specPath = join(worktree, 'brief-9000077.md');
      const logs: string[] = [];
      const result = await planPhase({
        // A brief's run number is a stand-in in the reserved 9,000,000+ range.
        issue: workKeyFromIssue(9_000_077),
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit: { rest: { issues: { createComment } } } as any,
        log: (_type, msg) => logs.push(msg),
        workSources,
        workSource: { kind: 'local-brief', params: {} },
        sizeGateMode: opts.mode,
        slicePlanStore: opts.store,
        sizeBudget: { tokenBudget: 1_000_000, maxFiles: 12 },
      });
      return { result, stub, createComment, specPath, logs };
    }

    const memoryStore = () => {
      const saved: SlicePlan[] = [];
      const store: SlicePlanStore = {
        find: async () => (saved[0] ? { status: 'found', plan: saved[0], where: 'mem' } : { status: 'not-found' }),
        save: async (plan) => {
          saved.push(plan);
          return { where: 'mem' };
        },
      };
      return { store, saved };
    };

    it('a brief source with a slice-plan store in stack mode slices an over-budget plan and records it in the store', async () => {
      const { store, saved } = memoryStore();
      const { result, stub, createComment } = await runBrief({ files: 13, store, mode: 'stack' });

      expect(result.ok).toBe(false);
      expect(result.sliced).toEqual({ sliceCount: 2 });
      expect(stub.calls.map((c) => c.task)).toEqual(['plan', 'decompose']);
      expect(saved).toHaveLength(1);
      expect(saved[0]?.slices).toHaveLength(2);
      expect(createComment).not.toHaveBeenCalled();
    });

    it('a brief source within budget in stack mode does not slice', async () => {
      const { store, saved } = memoryStore();
      const { result, stub } = await runBrief({ files: 3, store, mode: 'stack' });

      expect(result.ok).toBe(true);
      expect(stub.calls.map((c) => c.task)).toEqual(['plan']);
      expect(saved).toEqual([]);
    });

    it('a brief slice is planned with no stand-in run number in its issue body or slice label', async () => {
      const { store } = memoryStore();
      await runBrief({ files: 13, store, mode: 'stack' });
      const { result, stub, specPath, logs } = await runBrief({ files: 3, store, mode: 'stack' });

      expect(result.slice?.index).toBe(1);
      const planned = [...stub.calls.map((c) => c.prompt), readFileSync(specPath, 'utf8')].join('\n');
      const body = /<untrusted-issue-body>\n([\s\S]*?)\n<\/untrusted-issue-body>/.exec(planned)?.[1] ?? '';
      expect(body).toContain('Problem 1');
      expect(body).not.toMatch(/9000077|#9\d/);
      expect(logs).toContain('planning slice 1/2: Story 1');
    });

    it('file mode without a store is not gated', async () => {
      const { result, stub, createComment } = await runBrief({ files: 13, mode: 'file' });

      expect(result.ok).toBe(true);
      expect(stub.calls.map((c) => c.task)).toEqual(['plan']);
      expect(createComment).not.toHaveBeenCalled();
    });
  });
});
