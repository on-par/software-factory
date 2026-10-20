// Planner size-gate verdict and ESCALATE classification (#3275).
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { buildPlanPrompt, classifyEscalation, planPhase } from './plan.js';
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

const temps = createTempDirs();

afterEach(() => temps.cleanup());

const factoryTaskBody =
  '## Problem statement\nToo big.\n## In scope\n- one\n## Out of scope\n- rest\n## Acceptance criteria\n- [ ] works\n## Verification\nnpm test';

const list = (n: number, item: (i: number) => string) => Array.from({ length: n }, (_, i) => item(i)).join('\n');

const megaSliceYaml = `design:
  restatedProblem: A slice that is really five slices.
  approach:
    chosen: Do all of it.
    rejected: []
  interfacesTouched:
    - packages/a.ts
    - packages/b.ts
    - packages/c.ts
  targetTypes:
${list(7, (i) => `    - name: Type${i}\n      file: packages/t${i}.ts\n      kind: changed`)}
  signatures:
${list(7, (i) => `    - symbol: fn${i}\n      file: packages/f${i}.ts\n      signature: '(x: string) => void'`)}
  callGraph:
${list(7, (i) => `    - from: caller\n      to: fn${i}\n      note: edge`)}
  behaviorContract:
    - Everything changes.
  verificationPlan:
    - command: npm test
      passWhen: tests pass
  riskBlastRadius: Everything.
  openQuestions: []
`;

const validDecomposition = JSON.stringify({
  epic: {
    title: 'Split the mega slice',
    why: 'One slice is too big for one build pass.',
    doneWhen: ['The mega slice is split'],
    children: ['Small slice one'],
  },
  stories: [
    {
      title: 'Small slice one',
      role: 'engineer',
      want: 'a bounded slice',
      soThat: 'builds stay short',
      problemStatement: 'The slice is too big.',
      inScope: ['One file'],
      outOfScope: ['Everything else'],
      acceptanceCriteria: [{ name: 'Works', given: [], when: ['run'], then: ['works'] }],
      verification: [{ command: 'npm test', passWhen: 'passes' }],
      tracesTo: ['INT-PROBLEM-01'],
    },
  ],
});

const promptWith = (sizeGate?: { passed: boolean; enforced: boolean }) =>
  buildPlanPrompt({
    issue: 36,
    issueTitle: 'Add eval runner',
    issueBody: 'Measure the current prompt.',
    specPath: '/tmp/spec.md',
    constitutionCtx: '',
    sizeGate,
  });

describe('buildPlanPrompt size-gate verdict (#3275)', () => {
  it('plan prompt passes the size-gate verdict and does not invite a size ESCALATE when the gate passed', () => {
    const prompt = promptWith({ passed: true, enforced: true });
    expect(prompt).toContain('size gate passed');
    expect(prompt).toContain('ESCALATE: missing-info:');
    expect(prompt).toContain('ESCALATE: contradiction:');
    expect(prompt).not.toContain('asking to split the issue into smaller slices');
  });

  it('plan prompt keeps the size ESCALATE step unchanged when the size gate is not enforced or did not pass', () => {
    const base = promptWith();
    expect(base).toContain('asking to split the issue into smaller slices');
    expect(promptWith({ passed: true, enforced: false })).toBe(base);
    expect(promptWith({ passed: false, enforced: true })).toBe(base);
  });
});

describe('classifyEscalation (#3275)', () => {
  it('names missing-info and contradiction prefixes, case-insensitively', () => {
    expect(classifyEscalation('ESCALATE: missing-info: which provider?')).toBe('missing-info');
    expect(classifyEscalation('ESCALATE:   MISSING-INFO: which provider?')).toBe('missing-info');
    expect(classifyEscalation('ESCALATE: contradiction: AC1 vs out of scope')).toBe('contradiction');
  });

  it('labels size and split requests split', () => {
    expect(classifyEscalation('ESCALATE: Please split this into smaller slices')).toBe('split');
  });

  it('returns undefined for other escalations and no line', () => {
    expect(classifyEscalation('ESCALATE: which auth provider should we use?')).toBeUndefined();
    expect(classifyEscalation(undefined)).toBeUndefined();
  });
});

describe('planPhase size gate and escalateKind (#3275)', () => {
  it('a passed size gate tells the planner so, and an over-budget plan is decomposed by the post-plan gate, not escalated (#3275)', async () => {
    const worktree = await temps.make('plan-phase-test-');
    const stub = new StubModelExecutor({
      scripts: {
        plan: [{ output: `---\nroute: codex\n${megaSliceYaml}---\n# Spec\n` }],
        decompose: [{ output: validDecomposition }],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);
    const events: string[] = [];

    const result = await planPhase({
      issue: 903,
      repo: 'on-par/software-factory',
      worktree,
      specPath: join(worktree, 'issue-903.md'),
      router,
      constitution: null,
      octokit: {
        rest: {
          issues: {
            get: async () => ({ data: { title: 'Mega slice', body: factoryTaskBody } }),
            createComment: vi.fn().mockResolvedValue({}),
            create: vi.fn().mockResolvedValue({ data: { number: 904, id: 9904 } }),
          },
        },
        request: vi.fn().mockResolvedValue({ data: [] }),
      } as any,
      log: (type) => events.push(type),
    });

    expect(stub.calls.find((call) => call.task === 'plan')?.prompt).toContain('size gate passed');
    expect(result.decomposed).toBeDefined();
    expect(events).toContain('size-gate-decomposed');
    expect(events).not.toContain('escalate');
  });

  it.each([
    ['ESCALATE: missing-info: which provider?', 'missing-info'],
    ['ESCALATE: contradiction: AC1 vs out of scope', 'contradiction'],
    ['ESCALATE: Please split this issue', 'split'],
  ])('planner escalation %s logs escalateKind %s (#3275)', async (line, kind) => {
    const worktree = await temps.make('plan-phase-test-');
    const stub = new StubModelExecutor({ scripts: { plan: [{ output: `notes\n${line}\nmore text` }] } });
    const router = new ModelRouter(models, routes, false, stub);
    const octokit: any = {
      rest: { issues: { get: async () => ({ data: { title: 'Add auth', body: factoryTaskBody } }) } },
    };
    const escalates: Array<{ msg: string; extra: unknown }> = [];

    const result = await planPhase({
      issue: 45,
      repo: 'on-par/software-factory',
      worktree,
      specPath: join(worktree, 'issue-45.md'),
      router,
      constitution: null,
      octokit,
      log: (type, msg, extra) => {
        if (type === 'escalate') escalates.push({ msg, extra });
      },
    });

    expect(result.ok).toBe(false);
    expect(result.escalate).toBe(line);
    expect(escalates).toEqual([{ msg: line, extra: { escalateKind: kind } }]);
  });
});
