import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { specPaths } from '../spec/index.js';
import { UnsupportedWorkSourceError, WorkSourceRegistry } from '../work/index.js';
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
    'pinned-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub-model', 'pinned-model'] },
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

  it('includes the design: block template keys', () => {
    const prompt = buildPlanPrompt({
      issue: 36,
      issueTitle: 'Add eval runner',
      issueBody: 'Measure the current prompt.',
      specPath: '/tmp/spec.md',
      constitutionCtx: '',
    });

    expect(prompt).toContain('design:');
    expect(prompt).toContain('restatedProblem');
    expect(prompt).toContain('approach:');
    expect(prompt).toContain('interfacesTouched');
    expect(prompt).toContain('targetTypes');
    expect(prompt).toContain('signatures');
    expect(prompt).toContain('callGraph');
    expect(prompt).toContain('behaviorContract');
    expect(prompt).toContain('verificationPlan');
    expect(prompt).toContain('riskBlastRadius');
    expect(prompt).toContain('openQuestions');
    expect(prompt).toContain('grounded in the real checkout');
  });

  it('references the constitution above when constitutionCtx is non-empty', () => {
    const prompt = buildPlanPrompt({
      issue: 36,
      issueTitle: 'Add eval runner',
      issueBody: 'Measure the current prompt.',
      specPath: '/tmp/spec.md',
      constitutionCtx: 'STANDARDS TEXT',
    });

    expect(prompt).toContain('The constitution above defines the standards for this product.');
    expect(prompt).toContain('## Constitution compliance');
    expect(prompt).toContain('For each standard in the constitution, note how the plan satisfies it.');
    expect(prompt).not.toContain('No constitution loaded');
    expect(prompt).not.toContain('N/A — no constitution');
  });

  it('places a passed adrCtx block above the Issue heading', () => {
    const prompt = buildPlanPrompt({
      issue: 36,
      issueTitle: 'Add eval runner',
      issueBody: 'Measure the current prompt.',
      specPath: '/tmp/spec.md',
      constitutionCtx: '',
      adrCtx: '## Active architecture decisions (docs/adr)\n\nADR-0001 stuff.\n',
    });

    expect(prompt.indexOf('ADR-0001 stuff.')).toBeLessThan(prompt.indexOf('## Issue #36'));
  });

  it('includes the optional adr: frontmatter block and its guidance', () => {
    const prompt = buildPlanPrompt({
      issue: 36,
      issueTitle: 'Add eval runner',
      issueBody: 'Measure the current prompt.',
      specPath: '/tmp/spec.md',
      constitutionCtx: '',
    });

    expect(prompt).toContain('adr:');
    expect(prompt).toContain('OPTIONAL');
    expect(prompt).toContain("'why'");
    expect(prompt).toContain('docs/adr/');
  });
});

describe('planPhase', () => {
  it('bypasses the boss model only for a ready, bounded fast-path issue', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-493.md');
    const body = `## Problem statement
Status output has an extra blank line.
## In scope
- Update packages/cli/src/status.ts and its test.
## Out of scope
- Changing output format.
## Acceptance criteria
- [ ] Status has no blank line.
## Verification
npm test`;
    const stub = new StubModelExecutor({ scripts: {} });
    const router = new ModelRouter(models, routes, false, stub);

    const result = await planPhase({
      issue: 493,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      router,
      constitution: null,
      octokit: { rest: { issues: { get: async () => ({ data: { title: 'Fix status output', body } }) } } } as any,
      log: () => {},
      enforceReadiness: true,
      fastPath: true,
    });

    expect(result).toMatchObject({ ok: true, route: 'codex', model: 'fast-path' });
    expect(stub.calls).toHaveLength(0);
    expect(await readFile(specPath, 'utf8')).toContain('compact, deterministic PLAN artifact');
    expect(existsSync(specPath.replace(/\.md$/, '.design.json'))).toBe(true);
  });

  it('enriches an incomplete GitHub factory task before a single PLAN call', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-492.md');
    const updatedBodies: string[] = [];
    const completeBody = `## Problem statement
The import queue stalls.

## In scope
Repair queue processing.

## Out of scope
Changing the queue API.

## Acceptance criteria
- [ ] Queued imports complete.

## Verification
npm run test`;
    const stub = new StubModelExecutor({
      scripts: {
        readiness_enrich: [{ output: completeBody }],
        plan: [{ output: '---\nroute: codex\n---\n# Spec\n' }],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);
    const costs: { task: string }[] = [];
    router.setCostSink((entry) => costs.push(entry));
    const readinessEvents: any[] = [];
    const octokit: any = {
      rest: {
        issues: {
          get: async () => ({ data: { title: 'Repair import queue', body: '' } }),
          update: async ({ body }: { body: string }) => updatedBodies.push(body),
        },
      },
    };

    const result = await planPhase({
      issue: 492,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      router,
      constitution: null,
      octokit,
      log: (type, _msg, extra) => {
        if (type === 'readiness') readinessEvents.push(extra);
      },
      enforceReadiness: true,
    });

    expect(result.ok).toBe(true);
    expect(updatedBodies).toEqual([completeBody]);
    expect(stub.calls.map((call) => call.task)).toEqual(['readiness_enrich', 'plan']);
    expect(costs.map((entry) => entry.task)).toEqual(['readiness_enrich', 'plan']);
    expect(readinessEvents).toEqual([
      { readiness: { template: 'factory-task', score: 1, pass: true, missing: [], sizeOk: true } },
    ]);
  });

  it('does not call PLAN or overwrite the issue when enrichment is invalid', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const stub = new StubModelExecutor({ scripts: { readiness_enrich: [{ output: 'not a factory task' }] } });
    const router = new ModelRouter(models, routes, false, stub);
    const update = async () => {
      throw new Error('must not update');
    };
    const result = await planPhase({
      issue: 492,
      repo: 'on-par/software-factory',
      worktree,
      specPath: join(worktree, 'issue-492.md'),
      router,
      constitution: null,
      octokit: {
        rest: { issues: { get: async () => ({ data: { title: 'Repair import queue', body: '' } }), update } },
      } as any,
      log: () => {},
      enforceReadiness: true,
    });

    expect(result.ok).toBe(false);
    expect(stub.calls.map((call) => call.task)).toEqual(['readiness_enrich']);
  });

  it('does not call PLAN when persisting a valid enrichment fails', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const validBody = `## Problem statement
Queue stalls.
## In scope
Repair it.
## Out of scope
API changes.
## Acceptance criteria
- [ ] Queue works.
## Verification
npm run test`;
    const stub = new StubModelExecutor({ scripts: { readiness_enrich: [{ output: validBody }] } });
    const router = new ModelRouter(models, routes, false, stub);
    const result = await planPhase({
      issue: 492,
      repo: 'on-par/software-factory',
      worktree,
      specPath: join(worktree, 'issue-492.md'),
      router,
      constitution: null,
      octokit: {
        rest: {
          issues: {
            get: async () => ({ data: { title: 'Repair import queue', body: '' } }),
            update: async () => {
              throw new Error('GitHub unavailable');
            },
          },
        },
      } as any,
      log: () => {},
      enforceReadiness: true,
    });

    expect(result.ok).toBe(false);
    expect(stub.calls.map((call) => call.task)).toEqual(['readiness_enrich']);
  });

  it('skips enrichment for an already-ready factory task', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const readyBody = `## Problem statement
Queue stalls.
## In scope
Repair it.
## Out of scope
API changes.
## Acceptance criteria
- [ ] Queue works.
## Verification
npm run test`;
    const stub = new StubModelExecutor({ scripts: { plan: [{ output: '---\nroute: codex\n---\n# Spec\n' }] } });
    const router = new ModelRouter(models, routes, false, stub);
    let updates = 0;
    const result = await planPhase({
      issue: 492,
      repo: 'on-par/software-factory',
      worktree,
      specPath: join(worktree, 'issue-492.md'),
      router,
      constitution: null,
      octokit: {
        rest: {
          issues: {
            get: async () => ({ data: { title: 'Repair import queue', body: readyBody } }),
            update: async () => updates++,
          },
        },
      } as any,
      log: () => {},
      enforceReadiness: true,
    });

    expect(result.ok).toBe(true);
    expect(stub.calls.map((call) => call.task)).toEqual(['plan']);
    expect(updates).toBe(0);
  });

  describe('enforced size gate for oversized issues (#607)', () => {
    const oversizedBody = `## Problem statement
The import queue stalls under load and loses jobs.

## In scope
- Item 1
- Item 2
- Item 3
- Item 4
- Item 5
- Item 6

## Out of scope
Changing the queue API.

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3
- [ ] Criterion 4
- [ ] Criterion 5
- [ ] Criterion 6

## Verification
npm run test`;

    const validDecomposition = JSON.stringify({
      epic: {
        title: 'Harden the import queue',
        why: 'The import queue stalls under load and loses jobs.',
        doneWhen: ['Imports complete without stalls'],
        children: ['Retry failed import jobs'],
      },
      stories: [
        {
          title: 'Retry failed import jobs',
          role: 'operator',
          want: 'failed import jobs retry automatically',
          soThat: 'transient failures do not lose work',
          problemStatement: 'The import queue loses jobs on transient failure.',
          inScope: ['Add a bounded retry with backoff'],
          outOfScope: ['Persistent queue storage'],
          acceptanceCriteria: [
            {
              name: 'Failed jobs retry',
              given: ['a job fails'],
              when: ['the job fails transiently'],
              then: ['the job retries up to 3 times'],
            },
          ],
          verification: [{ command: 'npm test', passWhen: 'the retry suite passes' }],
          tracesTo: ['INT-PROBLEM-01'],
        },
      ],
    });

    const investFailingDecomposition = JSON.stringify({
      epic: { title: 'Epic', why: 'why', doneWhen: ['done'], children: ['Story one'] },
      stories: [
        {
          title: 'Story one',
          role: 'operator',
          want: 'the thing works',
          soThat: 'value',
          problemStatement: 'problem',
          inScope: ['in scope item'],
          outOfScope: ['persistent storage'],
          acceptanceCriteria: [{ name: 'works', given: [], when: ['run'], then: ['works'] }],
          verification: [{ command: 'npm test', passWhen: 'passes' }],
        },
      ],
    });

    it('decomposes and parks a complete oversized factory-task by default', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-607.md');
      const stub = new StubModelExecutor({
        scripts: {
          decompose: [{ output: validDecomposition }],
        },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const createComment = vi.fn().mockResolvedValue({});
      const events: string[] = [];

      const result = await planPhase({
        issue: 607,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit: {
          rest: {
            issues: {
              get: async () => ({ data: { title: 'Harden the import queue', body: oversizedBody } }),
              createComment,
            },
          },
        } as any,
        log: (type) => events.push(type),
      });

      expect(result.ok).toBe(false);
      expect(result.escalate).toMatch(/size gate/);
      expect(result.route).toBe('claude');
      expect(stub.calls.map((call) => call.task)).toEqual(['decompose']);
      expect(createComment).toHaveBeenCalledTimes(1);
      expect(createComment).toHaveBeenCalledWith({
        owner: 'on-par',
        repo: 'software-factory',
        issue_number: 607,
        body: expect.stringContaining('## Proposed epic: Harden the import queue'),
      });
      expect(events).toContain('size-gate-escalated');
      expect(events).toContain('decompose_comment_posted');
    });

    it('parks with size-gate-escalated even when the decomposition fails INVEST', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-607.md');
      const stub = new StubModelExecutor({
        scripts: {
          decompose: [{ output: investFailingDecomposition }, { output: investFailingDecomposition }],
        },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const createComment = vi.fn().mockResolvedValue({});
      const events: string[] = [];

      const result = await planPhase({
        issue: 607,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit: {
          rest: {
            issues: {
              get: async () => ({ data: { title: 'Harden the import queue', body: oversizedBody } }),
              createComment,
            },
          },
        } as any,
        log: (type) => events.push(type),
      });

      expect(result.ok).toBe(false);
      expect(result.escalate).toMatch(/size gate/);
      expect(stub.calls.map((call) => call.task)).toEqual(['decompose', 'decompose']);
      expect(createComment).not.toHaveBeenCalled();
      expect(events).toContain('decompose_failed');
      expect(events).toContain('size-gate-escalated');
    });

    it('proceeds to PLAN when enforceSizeGate is false', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-607.md');
      const stub = new StubModelExecutor({
        scripts: {
          plan: [{ output: '---\nroute: codex\n---\n# Spec\n' }],
        },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const createComment = vi.fn().mockResolvedValue({});
      const events: string[] = [];

      const result = await planPhase({
        issue: 607,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit: {
          rest: {
            issues: {
              get: async () => ({ data: { title: 'Harden the import queue', body: oversizedBody } }),
              createComment,
            },
          },
        } as any,
        log: (type) => events.push(type),
        enforceSizeGate: false,
      });

      expect(result.ok).toBe(true);
      expect(result.route).toBe('codex');
      expect(stub.calls.map((call) => call.task)).toEqual(['plan']);
      expect(createComment).not.toHaveBeenCalled();
      expect(events).not.toContain('size-gate-escalated');
    });
  });

  it('stops before PLAN when the enrichment router fails', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const stub = new StubModelExecutor({ scripts: { readiness_enrich: [{ fail: 'error' }] } });
    const router = new ModelRouter(models, routes, false, stub);
    const events: string[] = [];
    const result = await planPhase({
      issue: 492,
      repo: 'on-par/software-factory',
      worktree,
      specPath: join(worktree, 'issue-492.md'),
      router,
      constitution: null,
      octokit: { rest: { issues: { get: async () => ({ data: { title: 'Repair import queue', body: '' } }) } } } as any,
      log: (type) => events.push(type),
      enforceReadiness: true,
    });

    expect(result.ok).toBe(false);
    expect(stub.calls.every((call) => call.task === 'readiness_enrich')).toBe(true);
    expect(events).toContain('readiness_enrichment_failed');
  });

  it('passes timeoutSeconds through to the router', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-36.md');
    let captured: number | undefined;
    const stub = new StubModelExecutor({
      scripts: {
        plan: [
          {
            output: '---\nroute: codex\n---\n# Spec\n',
            effect: (ctx) => {
              captured = ctx.timeoutSeconds;
            },
          },
        ],
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
      constitution: null,
      octokit,
      log: () => {},
      timeoutSeconds: 900,
    });

    expect(captured).toBe(900);
  });

  it('routes to the default tier-order model when no modelOverride is given', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-40.md');
    const stub = new StubModelExecutor({
      scripts: {
        plan: [
          {
            output: '---\nroute: codex\n---\n# Spec\n',
          },
        ],
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
      issue: 40,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      router,
      constitution: null,
      octokit,
      log: () => {},
    });

    expect(stub.calls[0].model).toBe('stub-model');
  });

  it('pins the plan model via modelOverride, bypassing default tier order', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-41.md');
    const stub = new StubModelExecutor({
      scripts: {
        plan: [
          {
            output: '---\nroute: codex\n---\n# Spec\n',
          },
        ],
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

    const result = await planPhase({
      issue: 41,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      router,
      constitution: null,
      octokit,
      log: () => {},
      modelOverride: 'pinned-model',
    });

    expect(result.ok).toBe(true);
    expect(stub.calls[0].model).toBe('pinned-model');
  });

  it('parses a quoted codex route from frontmatter', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-36.md');
    const stub = new StubModelExecutor({
      scripts: {
        plan: [
          {
            output: '---\nroute: "codex"\n---\n# Spec\n',
          },
        ],
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

    const result = await planPhase({
      issue: 36,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      router,
      constitution: null,
      octokit,
      log: () => {},
    });

    expect(result.route).toBe('codex');
  });

  it('trims incidental whitespace inside a quoted route value', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-37.md');
    const stub = new StubModelExecutor({
      scripts: {
        plan: [
          {
            output: '---\nroute: "codex "\n---\n# Spec\n',
          },
        ],
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

    const result = await planPhase({
      issue: 37,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      router,
      constitution: null,
      octokit,
      log: () => {},
    });

    expect(result.route).toBe('codex');
  });

  it('archives a pre-existing spec before writing the fresh plan output', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-38.md');
    await writeFile(specPath, '---\nroute: claude\n---\n# Stale Spec\n');

    const stub = new StubModelExecutor({
      scripts: {
        plan: [
          {
            output: '---\nroute: codex\n---\n# Fresh Spec\n',
          },
        ],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);
    const octokit: any = {
      rest: {
        issues: {
          get: async () => ({ data: { title: 'Refresh stale plan', body: 'Do not reuse old specs.' } }),
        },
      },
    };
    const logs: Array<{ type: string; msg: string }> = [];

    const result = await planPhase({
      issue: 38,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      router,
      constitution: null,
      octokit,
      log: (type, msg) => {
        logs.push({ type, msg });
      },
    });

    expect(result.route).toBe('codex');
    await expect(readFile(specPath, 'utf-8')).resolves.toContain('# Fresh Spec');

    const archived = await readdir(join(worktree, '.archive'));
    expect(archived).toHaveLength(1);
    await expect(readFile(join(worktree, '.archive', archived[0]), 'utf-8')).resolves.toContain('# Stale Spec');
    expect(logs.some((l) => l.type === 'plan' && l.msg.startsWith('Archived existing spec before planning:'))).toBe(
      true,
    );
  });

  describe('design artifact (#422)', () => {
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

    it('writes .design.json and .design.md, populates result.designArtifact, and logs design_artifact_emitted', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-422.md');
      const stub = new StubModelExecutor({
        scripts: {
          plan: [
            {
              output: `---\nroute: codex\n${validDesignYaml}  openQuestions: []\n---\n# Spec\n`,
            },
          ],
        },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const octokit: any = {
        rest: { issues: { get: async () => ({ data: { title: 'Design artifact', body: 'Body.' } }) } },
      };
      const logs: Array<{ type: string; msg: string }> = [];

      const result = await planPhase({
        issue: 422,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit,
        log: (type, msg) => logs.push({ type, msg }),
      });

      expect(result.designArtifact).not.toBeNull();
      expect(result.designArtifact?.restatedProblem).toBe('The problem statement, restated.');
      await expect(readFile(`${specPath.replace(/\.md$/, '')}.design.json`, 'utf-8')).resolves.toContain(
        'restatedProblem',
      );
      await expect(readFile(`${specPath.replace(/\.md$/, '')}.design.md`, 'utf-8')).resolves.toContain(
        '## Design artifact (#422)',
      );
      expect(logs.some((l) => l.type === 'design_artifact_emitted')).toBe(true);
      expect(logs.some((l) => l.type === 'design_open_questions')).toBe(false);
    });

    it('logs design_shallow when the design block carries no targetTypes, signatures, or callGraph', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-427.md');
      const stub = new StubModelExecutor({
        scripts: {
          plan: [
            {
              output: `---\nroute: codex\n${validDesignYaml}  openQuestions: []\n---\n# Spec\n`,
            },
          ],
        },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const octokit: any = {
        rest: { issues: { get: async () => ({ data: { title: 'Shallow design', body: 'Body.' } }) } },
      };
      const logs: Array<{ type: string; msg: string }> = [];

      const result = await planPhase({
        issue: 427,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit,
        log: (type, msg) => logs.push({ type, msg }),
      });

      expect(result.ok).toBe(true);
      expect(logs.some((l) => l.type === 'design_shallow')).toBe(true);
    });

    it('parses targetTypes, signatures, and callGraph, and logs counts with no design_shallow', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-480.md');
      const deepenedYaml = `design:
  restatedProblem: The problem statement, restated.
  approach:
    chosen: Do the thing.
    rejected:
      - option: Alt approach
        reason: Worse.
  interfacesTouched:
    - packages/core/src/foo.ts
  targetTypes:
    - name: Foo
      file: packages/core/src/foo.ts
      kind: changed
  signatures:
    - symbol: doThing
      file: packages/core/src/foo.ts
      signature: '(x: string) => void'
  callGraph:
    - from: buildPhase
      to: doThing
      note: invoked during build
  behaviorContract:
    - Foo now does bar.
  verificationPlan:
    - command: npm test
      passWhen: tests pass
  riskBlastRadius: Nothing breaks.
  openQuestions: []
`;
      const stub = new StubModelExecutor({
        scripts: {
          plan: [{ output: `---\nroute: codex\n${deepenedYaml}---\n# Spec\n` }],
        },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const octokit: any = {
        rest: { issues: { get: async () => ({ data: { title: 'Deepened design', body: 'Body.' } }) } },
      };
      const logs: Array<{ type: string; msg: string }> = [];

      const result = await planPhase({
        issue: 480,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit,
        log: (type, msg) => logs.push({ type, msg }),
      });

      expect(result.designArtifact?.targetTypes).toEqual([
        { name: 'Foo', file: 'packages/core/src/foo.ts', kind: 'changed' },
      ]);
      expect(result.designArtifact?.signatures).toEqual([
        { symbol: 'doThing', file: 'packages/core/src/foo.ts', signature: '(x: string) => void' },
      ]);
      expect(result.designArtifact?.callGraph).toEqual([
        { from: 'buildPhase', to: 'doThing', note: 'invoked during build' },
      ]);
      const emittedLog = logs.find((l) => l.type === 'design_artifact_emitted');
      expect(emittedLog?.msg).toContain('target types: 1');
      expect(emittedLog?.msg).toContain('signatures: 1');
      expect(emittedLog?.msg).toContain('call edges: 1');
      expect(logs.some((l) => l.type === 'design_shallow')).toBe(false);
    });

    it('logs design_open_questions with the question text when openQuestions is non-empty', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-423.md');
      const stub = new StubModelExecutor({
        scripts: {
          plan: [
            {
              output: `---\nroute: codex\n${validDesignYaml}  openQuestions:\n    - is X intended?\n---\n# Spec\n`,
            },
          ],
        },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const octokit: any = {
        rest: { issues: { get: async () => ({ data: { title: 'Open questions', body: 'Body.' } }) } },
      };
      const logs: Array<{ type: string; msg: string }> = [];

      const result = await planPhase({
        issue: 423,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit,
        log: (type, msg) => logs.push({ type, msg }),
      });

      expect(result.designArtifact?.openQuestions).toEqual(['is X intended?']);
      const questionLog = logs.find((l) => l.type === 'design_open_questions');
      expect(questionLog?.msg).toContain('is X intended?');
    });

    it('leaves designArtifact null and logs design_artifact_invalid when the spec has no design block', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-424.md');
      const stub = new StubModelExecutor({
        scripts: {
          plan: [{ output: '---\nroute: codex\n---\n# Spec\n' }],
        },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const octokit: any = {
        rest: { issues: { get: async () => ({ data: { title: 'No design block', body: 'Body.' } }) } },
      };
      const logs: Array<{ type: string; msg: string }> = [];

      const result = await planPhase({
        issue: 424,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit,
        log: (type, msg) => logs.push({ type, msg }),
      });

      expect(result.ok).toBe(true);
      expect(result.designArtifact).toBeNull();
      expect(logs.some((l) => l.type === 'design_artifact_invalid')).toBe(true);
      expect(existsSync(`${specPath.replace(/\.md$/, '')}.design.json`)).toBe(false);
    });

    it('archives a pre-existing design artifact alongside a replanned spec', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-425.md');
      await writeFile(specPath, '---\nroute: claude\n---\n# Stale Spec\n');
      await writeFile(`${specPath.replace(/\.md$/, '')}.design.json`, JSON.stringify({ stale: true }));

      const stub = new StubModelExecutor({
        scripts: {
          plan: [{ output: '---\nroute: codex\n---\n# Fresh Spec\n' }],
        },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const octokit: any = {
        rest: { issues: { get: async () => ({ data: { title: 'Replan', body: 'Body.' } }) } },
      };

      await planPhase({
        issue: 425,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit,
        log: () => {},
      });

      const archived = await readdir(join(worktree, '.archive'));
      expect(archived.some((f) => f.endsWith('.design.json'))).toBe(true);
      expect(existsSync(`${specPath.replace(/\.md$/, '')}.design.json`)).toBe(false);
    });
  });

  describe('FACTORY_CODEX kill-switch', () => {
    it('forces route to codex when localOnly is set so builds use the local agent harness', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-79.md');
      const stub = new StubModelExecutor({
        scripts: {
          plan: [
            {
              output: '---\nroute: claude\n---\n# Spec\n',
            },
          ],
        },
      });
      const router = new ModelRouter(models, routes, false, stub, false, false);
      const octokit: any = {
        rest: {
          issues: {
            get: async () => ({ data: { title: 'Use local models', body: 'Keep spend at zero.' } }),
          },
        },
      };
      const logs: Array<{ type: string; msg: string }> = [];

      const result = await planPhase({
        issue: 79,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit,
        log: (type, msg) => {
          logs.push({ type, msg });
        },
        localOnly: true,
      });

      expect(result.route).toBe('codex');
      expect(logs).toContainEqual({
        type: 'warn',
        msg: 'local-only mode requires a local Codex harness — forcing route to codex',
      });

      const persisted = await readFile(specPath, 'utf-8');
      expect(persisted).toContain('route: codex');
      expect(persisted).not.toContain('route: claude');
    });

    it('forces route to claude and logs a warn when codex is disabled', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-79.md');
      const stub = new StubModelExecutor({
        scripts: {
          plan: [
            {
              output: '---\nroute: codex\n---\n# Spec\n',
            },
          ],
        },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const octokit: any = {
        rest: {
          issues: {
            get: async () => ({ data: { title: 'Add kill-switch', body: 'Add FACTORY_CODEX=0.' } }),
          },
        },
      };
      const logs: Array<{ type: string; msg: string }> = [];

      const result = await planPhase({
        issue: 79,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit,
        log: (type, msg) => {
          logs.push({ type, msg });
        },
        codexDisabled: true,
      });

      expect(result.route).toBe('claude');
      expect(logs).toContainEqual({ type: 'warn', msg: 'codex unavailable — falling back to claude' });

      const persisted = await readFile(specPath, 'utf-8');
      expect(persisted).toContain('route: claude');
      expect(persisted).not.toContain('route: codex');
    });

    it('keeps route codex when neither the env nor the opt disables codex', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-79.md');
      const stub = new StubModelExecutor({
        scripts: {
          plan: [
            {
              output: '---\nroute: codex\n---\n# Spec\n',
            },
          ],
        },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const octokit: any = {
        rest: {
          issues: {
            get: async () => ({ data: { title: 'Add kill-switch', body: 'Add FACTORY_CODEX=0.' } }),
          },
        },
      };

      const result = await planPhase({
        issue: 79,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit,
        log: () => {},
      });

      expect(result.route).toBe('codex');
    });

    it('forces route to claude via the codexDisabled opt', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-79.md');
      const stub = new StubModelExecutor({
        scripts: {
          plan: [{ output: '---\nroute: codex\n---\n# Spec\n' }],
        },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const octokit: any = {
        rest: {
          issues: {
            get: async () => ({ data: { title: 'Repo-pinned kill-switch', body: 'Disable codex via repo config.' } }),
          },
        },
      };
      const logs: Array<{ type: string; msg: string }> = [];

      const result = await planPhase({
        issue: 79,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit,
        log: (type, msg) => {
          logs.push({ type, msg });
        },
        codexDisabled: true,
      });

      expect(result.route).toBe('claude');
      expect(logs).toContainEqual({ type: 'warn', msg: 'codex unavailable — falling back to claude' });
    });
  });

  it('emits a structured failover event when the router fails over to a different model', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-40.md');
    const stub = new StubModelExecutor({
      scripts: {
        plan: [{ fail: 'usage_cap' }, { output: '---\nroute: codex\n---\n# Spec\n' }],
      },
    });
    const failoverModels: ModelsConfig = {
      ...models,
      models: {
        ...models.models,
        'pinned-model': { ...models.models['pinned-model'], provider: 'openai' },
      },
    };
    const router = new ModelRouter(failoverModels, routes, false, stub);
    const octokit: any = {
      rest: {
        issues: {
          get: async () => ({ data: { title: 'Add eval runner', body: 'Measure the current prompt.' } }),
        },
      },
    };
    const logCalls: Array<[string, string, ({ failoverReason?: string } | undefined)?]> = [];

    await planPhase({
      issue: 40,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      router,
      constitution: null,
      octokit,
      log: (type, msg, extra) => {
        logCalls.push([type, msg, extra]);
      },
    });

    expect(logCalls).toContainEqual([
      'failover',
      expect.stringContaining('usage_cap'),
      { failoverReason: 'usage_cap' },
    ]);
  });

  it('omits the detail suffix from the failover log when the failed attempt carries no descriptive detail', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-42.md');
    let calls = 0;
    const executor = {
      async runModel() {
        calls++;
        if (calls === 1) throw new Error('');
        return '---\nroute: codex\n---\n# Spec\n';
      },
    };
    const router = new ModelRouter(models, routes, false, executor as any);
    const octokit: any = {
      rest: {
        issues: {
          get: async () => ({ data: { title: 'Add eval runner', body: 'Measure the current prompt.' } }),
        },
      },
    };
    const logCalls: Array<[string, string, ({ failoverReason?: string } | undefined)?]> = [];

    const result = await planPhase({
      issue: 42,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      router,
      constitution: null,
      octokit,
      log: (type, msg, extra) => {
        logCalls.push([type, msg, extra]);
      },
    });

    expect(result.ok).toBe(true);
    const failoverLog = logCalls.find(([type]) => type === 'failover');
    expect(failoverLog?.[1]).toMatch(/failed \(unknown\) — failed over$/);
  });

  it('returns not-ok and surfaces the ESCALATE line when the planner escalates', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-43.md');
    const stub = new StubModelExecutor({
      scripts: {
        plan: [{ output: 'notes\nESCALATE: which auth provider should we use?\nmore text' }],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);
    const octokit: any = {
      rest: {
        issues: {
          get: async () => ({ data: { title: 'Add auth', body: 'Add authentication.' } }),
        },
      },
    };
    const logs: Array<{ type: string; msg: string }> = [];

    const result = await planPhase({
      issue: 43,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      router,
      constitution: null,
      octokit,
      log: (type, msg) => {
        logs.push({ type, msg });
      },
    });

    expect(result.ok).toBe(false);
    expect(result.route).toBe('claude');
    expect(result.escalate).toBe('ESCALATE: which auth provider should we use?');
    expect(logs).toContainEqual({ type: 'escalate', msg: 'ESCALATE: which auth provider should we use?' });
  });

  it('logs exactly one readiness event with a structured payload, including on the escalation path', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-44.md');
    const stub = new StubModelExecutor({
      scripts: {
        plan: [{ output: 'notes\nESCALATE: which auth provider should we use?\nmore text' }],
      },
    });
    const router = new ModelRouter(models, routes, false, stub);
    const octokit: any = {
      rest: {
        issues: {
          get: async () => ({ data: { title: 'Add auth', body: 'Add authentication.' } }),
        },
      },
    };
    const logCalls: Array<[string, string, unknown]> = [];

    await planPhase({
      issue: 44,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      router,
      constitution: null,
      octokit,
      log: (type, msg, extra) => {
        logCalls.push([type, msg, extra]);
      },
    });

    const readinessCalls = logCalls.filter(([type]) => type === 'readiness');
    expect(readinessCalls).toHaveLength(1);
    const [, msg, extra] = readinessCalls[0];
    expect(msg).toContain('issue readiness');
    expect(extra).toMatchObject({
      readiness: { template: 'factory-task', pass: false },
    });
  });

  it('defaults a null issue body to an empty string instead of the literal "null"', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-44.md');
    const stub = new StubModelExecutor({
      scripts: { plan: [{ output: '---\nroute: codex\n---\n# Spec\n' }] },
    });
    const router = new ModelRouter(models, routes, false, stub);
    const octokit: any = {
      rest: {
        issues: {
          get: async () => ({ data: { title: 'No body issue', body: null } }),
        },
      },
    };

    const result = await planPhase({
      issue: 44,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      router,
      constitution: null,
      octokit,
      log: () => {},
    });

    expect(result.ok).toBe(true);
    expect(stub.calls[0].prompt).not.toContain('null');
  });

  it('keeps the default claude route when frontmatter route is a non-string value', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-45.md');
    const stub = new StubModelExecutor({
      scripts: { plan: [{ output: '---\nroute: 123\n---\n# Spec\n' }] },
    });
    const router = new ModelRouter(models, routes, false, stub);
    const octokit: any = {
      rest: {
        issues: {
          get: async () => ({ data: { title: 'Add eval runner', body: 'Measure the current prompt.' } }),
        },
      },
    };

    const result = await planPhase({
      issue: 45,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      router,
      constitution: null,
      octokit,
      log: () => {},
    });

    expect(result.route).toBe('claude');
  });

  it('keeps the default claude route when frontmatter YAML is malformed', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-47.md');
    const stub = new StubModelExecutor({
      scripts: { plan: [{ output: '---\nroute: [unclosed\n---\n# Spec\n' }] },
    });
    const router = new ModelRouter(models, routes, false, stub);
    const octokit: any = {
      rest: {
        issues: {
          get: async () => ({ data: { title: 'Add eval runner', body: 'Measure the current prompt.' } }),
        },
      },
    };

    const result = await planPhase({
      issue: 47,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      router,
      constitution: null,
      octokit,
      log: () => {},
    });

    expect(result.ok).toBe(true);
    expect(result.route).toBe('claude');
  });

  it('skips writing the spec when the model already wrote it directly via file tools', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-46.md');
    const output = '---\nroute: codex\n---\n# Written directly by the model\n';
    const stub = new StubModelExecutor({
      scripts: {
        plan: [
          {
            output,
            effect: async () => {
              await writeFile(specPath, output);
            },
          },
        ],
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

    const result = await planPhase({
      issue: 46,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      router,
      constitution: null,
      octokit,
      log: () => {},
    });

    expect(result.ok).toBe(true);
    await expect(readFile(specPath, 'utf-8')).resolves.toBe(output);
  });

  describe('plan-approval gate', () => {
    it('is unchanged when no approvalGate is passed (disabled default)', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-50.md');
      const stub = new StubModelExecutor({
        scripts: { plan: [{ output: '---\nroute: codex\n---\n# Spec\n' }] },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const octokit: any = {
        rest: {
          issues: {
            get: async () => ({ data: { title: 'Add eval runner', body: 'Measure the current prompt.' } }),
          },
        },
      };
      const gateCalled = false;

      const result = await planPhase({
        issue: 50,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit,
        log: () => {},
      });

      expect(result.ok).toBe(true);
      expect(gateCalled).toBe(false);
    });

    it('grants approval and returns ok, requesting a kind:"plan" approval with the frozen spec', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-51.md');
      const stub = new StubModelExecutor({
        scripts: { plan: [{ output: '---\nroute: codex\n---\n# Spec v1\n' }] },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const octokit: any = {
        rest: {
          issues: {
            get: async () => ({ data: { title: 'Add eval runner', body: 'Measure the current prompt.' } }),
          },
        },
      };
      const logs: Array<{ type: string; msg: string }> = [];
      let gateCalls = 0;
      let capturedRequest: any;

      const result = await planPhase({
        issue: 51,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit,
        log: (type, msg) => logs.push({ type, msg }),
        approvalGate: async (req) => {
          gateCalls++;
          capturedRequest = req;
          return { id: 'x', approved: true, respondedAt: new Date().toISOString() };
        },
      });

      expect(result.ok).toBe(true);
      expect(gateCalls).toBe(1);
      expect(capturedRequest.kind).toBe('plan');
      expect(capturedRequest.specPreview).toContain('# Spec v1');
      expect(logs.some((l) => l.type === 'plan_approval_granted')).toBe(true);
    });

    it('re-plans on a redirect: applies steering to the next prompt and returns the revised spec', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-52.md');
      const stub = new StubModelExecutor({
        scripts: {
          plan: [{ output: '---\nroute: codex\n---\n# Spec v1\n' }, { output: '---\nroute: codex\n---\n# Spec v2\n' }],
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
      const logs: Array<{ type: string; msg: string }> = [];
      let gateCalls = 0;
      let drainCalls = 0;

      const result = await planPhase({
        issue: 52,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit,
        log: (type, msg) => logs.push({ type, msg }),
        approvalGate: async () => {
          gateCalls++;
          return {
            id: 'x',
            approved: gateCalls > 1,
            respondedAt: new Date().toISOString(),
          };
        },
        drainSteering: () => {
          drainCalls++;
          return drainCalls === 1
            ? {
                messages: [{ id: 'm1', issue: 52, text: 'use provider X', queuedAt: new Date().toISOString() }],
                attachments: [],
              }
            : { messages: [], attachments: [] };
        },
      });

      expect(stub.calls.length).toBe(2);
      expect(stub.calls[1].prompt).toContain('Operator guidance (steering)');
      expect(stub.calls[1].prompt).toContain('use provider X');
      await expect(readFile(specPath, 'utf-8')).resolves.toContain('Spec v2');
      expect(result.ok).toBe(true);
      expect(logs.some((l) => l.type === 'plan_redirect')).toBe(true);
    });

    it('rejects without a redirect and escalates with the operator reason', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-53.md');
      const stub = new StubModelExecutor({
        scripts: { plan: [{ output: '---\nroute: codex\n---\n# Spec\n' }] },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const octokit: any = {
        rest: {
          issues: {
            get: async () => ({ data: { title: 'Add eval runner', body: 'Measure the current prompt.' } }),
          },
        },
      };
      const logs: Array<{ type: string; msg: string }> = [];

      const result = await planPhase({
        issue: 53,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit,
        log: (type, msg) => logs.push({ type, msg }),
        approvalGate: async () => ({
          id: 'x',
          approved: false,
          reason: 'wrong framing',
          respondedAt: new Date().toISOString(),
        }),
        drainSteering: () => ({ messages: [], attachments: [] }),
      });

      expect(result.ok).toBe(false);
      expect(result.escalate).toContain('wrong framing');
      expect(logs.some((l) => l.type === 'plan_rejected')).toBe(true);
    });

    it('bounds the redirect loop with maxReplans and escalates once exceeded', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-54.md');
      const stub = new StubModelExecutor({
        scripts: {
          plan: [
            { output: '---\nroute: codex\n---\n# Spec v1\n' },
            { output: '---\nroute: codex\n---\n# Spec v2\n' },
            { output: '---\nroute: codex\n---\n# Spec v3\n' },
          ],
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
      const logs: Array<{ type: string; msg: string }> = [];

      const result = await planPhase({
        issue: 54,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit,
        log: (type, msg) => logs.push({ type, msg }),
        maxReplans: 2,
        approvalGate: async () => ({ id: 'x', approved: false, respondedAt: new Date().toISOString() }),
        drainSteering: () => ({
          messages: [{ id: 'm1', issue: 54, text: 'try again', queuedAt: new Date().toISOString() }],
          attachments: [],
        }),
      });

      expect(result.ok).toBe(false);
      expect(result.escalate).toContain('re-plan limit');
      expect(stub.calls.length).toBe(3);
    });
  });

  describe('ADR constraints (#481)', () => {
    it('injects Accepted ADRs into the prompt and omits Superseded ones', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      await mkdir(join(worktree, 'docs', 'adr'), { recursive: true });
      await writeFile(
        join(worktree, 'docs', 'adr', '0001-x.md'),
        '# ADR-0001: Use fixture ADRs\n\n- Status: Accepted\n- Date: 2026-07-20\n\n## Decision\n\nDo the thing.\n',
      );
      await writeFile(
        join(worktree, 'docs', 'adr', '0002-y.md'),
        '# ADR-0002: Superseded fixture\n\n- Status: Superseded by ADR-0003\n- Date: 2026-07-20\n\n## Decision\n\nOld thing.\n',
      );

      const specPath = join(worktree, 'issue-481.md');
      const stub = new StubModelExecutor({
        scripts: { plan: [{ output: '---\nroute: codex\n---\n# Spec\n' }] },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const octokit: any = {
        rest: { issues: { get: async () => ({ data: { title: 'ADR reader', body: 'Body.' } }) } },
      };
      const logs: Array<{ type: string; msg: string }> = [];

      await planPhase({
        issue: 481,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit,
        log: (type, msg) => logs.push({ type, msg }),
      });

      const prompt = stub.calls[0]?.prompt ?? '';
      expect(prompt).toContain('ADR-0001');
      expect(prompt).toContain('Use fixture ADRs');
      expect(prompt).not.toContain('Superseded fixture');
      expect(logs.some((l) => l.type === 'adr_context')).toBe(true);
    });

    it('plans without ADR constraints when the worktree has no docs/adr', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-481.md');
      const stub = new StubModelExecutor({
        scripts: { plan: [{ output: '---\nroute: codex\n---\n# Spec\n' }] },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const octokit: any = {
        rest: { issues: { get: async () => ({ data: { title: 'No ADRs', body: 'Body.' } }) } },
      };
      const logs: Array<{ type: string; msg: string }> = [];

      await planPhase({
        issue: 481,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit,
        log: (type, msg) => logs.push({ type, msg }),
      });

      const prompt = stub.calls[0]?.prompt ?? '';
      expect(prompt).not.toContain('## Active architecture decisions');
      expect(logs.some((l) => l.type === 'adr_context_empty')).toBe(true);
    });
  });

  describe('ADR drafts (#482)', () => {
    it('writes <spec>.adr.json and logs adr_drafts for a valid adr: entry', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-482.md');
      const adrYaml = `adr:
  - title: Record ADR drafts during PLAN
    context: Decisions made during PLAN evaporate into spec prose.
    decision: SHIP materializes drafts as Accepted ADRs.
    consequences: Future PLAN runs can read prior decisions back.
`;
      const stub = new StubModelExecutor({
        scripts: {
          plan: [{ output: `---\nroute: codex\n${adrYaml}---\n# Spec\n` }],
        },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const octokit: any = {
        rest: { issues: { get: async () => ({ data: { title: 'ADR drafts', body: 'Body.' } }) } },
      };
      const logs: Array<{ type: string; msg: string }> = [];

      await planPhase({
        issue: 482,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit,
        log: (type, msg) => logs.push({ type, msg }),
      });

      const adrDraftsPath = specPaths(specPath).adr;
      const written = JSON.parse(await readFile(adrDraftsPath, 'utf-8'));
      expect(written).toEqual([
        {
          title: 'Record ADR drafts during PLAN',
          context: 'Decisions made during PLAN evaporate into spec prose.',
          decision: 'SHIP materializes drafts as Accepted ADRs.',
          consequences: 'Future PLAN runs can read prior decisions back.',
          status: 'proposed',
          references: [],
        },
      ]);
      const draftsLog = logs.find((l) => l.type === 'adr_drafts');
      expect(draftsLog?.msg).toContain('Record ADR drafts during PLAN');
    });

    it('refuses an adr: entry with an empty context, never freezing or writing it', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-483.md');
      const adrYaml = `adr:
  - title: Bad draft
    context: ''
    decision: Decided anyway.
    consequences: Some consequence.
`;
      const stub = new StubModelExecutor({
        scripts: {
          plan: [{ output: `---\nroute: codex\n${adrYaml}---\n# Spec\n` }],
        },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const octokit: any = {
        rest: { issues: { get: async () => ({ data: { title: 'Bad ADR draft', body: 'Body.' } }) } },
      };
      const logs: Array<{ type: string; msg: string }> = [];

      const result = await planPhase({
        issue: 483,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit,
        log: (type, msg) => logs.push({ type, msg }),
      });

      expect(result.ok).toBe(true);
      const adrDraftsPath = specPaths(specPath).adr;
      expect(existsSync(adrDraftsPath)).toBe(false);
      const rejectedLog = logs.find((l) => l.type === 'adr_draft_rejected');
      expect(rejectedLog?.msg).toMatch(/'why'\) is required/);
    });

    it('archives a pre-existing <spec>.adr.json alongside a replanned spec', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-484.md');
      await writeFile(specPath, '---\nroute: claude\n---\n# Stale Spec\n');
      await writeFile(`${specPath.replace(/\.md$/, '')}.adr.json`, JSON.stringify([{ stale: true }]));

      const stub = new StubModelExecutor({
        scripts: {
          plan: [{ output: '---\nroute: codex\n---\n# Fresh Spec\n' }],
        },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const octokit: any = {
        rest: { issues: { get: async () => ({ data: { title: 'Replan', body: 'Body.' } }) } },
      };

      await planPhase({
        issue: 484,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit,
        log: () => {},
      });

      const archived = await readdir(join(worktree, '.archive'));
      expect(archived.some((f) => f.endsWith('.adr.json'))).toBe(true);
      expect(existsSync(`${specPath.replace(/\.md$/, '')}.adr.json`)).toBe(false);
    });
  });

  describe('work request resolution (#505)', () => {
    it('fails before any phase work when the source kind is unsupported', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-505.md');
      const stub = new StubModelExecutor({
        scripts: { plan: [{ output: '---\nroute: codex\n---\n# Spec\n' }] },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const octokit: any = {
        rest: {
          issues: {
            get: async () => ({ data: { title: 'Add eval runner', body: 'Measure the current prompt.' } }),
          },
        },
      };
      const logs: Array<{ type: string; msg: string }> = [];

      let error: unknown;
      try {
        await planPhase({
          issue: 505,
          repo: 'on-par/software-factory',
          worktree,
          specPath,
          router,
          constitution: null,
          octokit,
          log: (type, msg) => logs.push({ type, msg }),
          workSource: { kind: 'jira', params: {} },
        });
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(UnsupportedWorkSourceError);
      expect((error as Error).message).toContain('jira');
      expect(stub.calls.length).toBe(0);
      expect(existsSync(specPath)).toBe(false);
      expect(logs.some((l) => l.type === 'plan')).toBe(false);
    });

    it('resolves a GitHub issue to a canonical work request and preserves the existing prompt mapping', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-505.md');
      const stub = new StubModelExecutor({
        scripts: { plan: [{ output: '---\nroute: codex\n---\n# Spec\n' }] },
      });
      const router = new ModelRouter(models, routes, false, stub);
      const octokit: any = {
        rest: {
          issues: {
            get: async () => ({ data: { title: 'Add eval runner', body: 'Measure the current prompt.' } }),
          },
        },
      };
      const logs: Array<{ type: string; msg: string }> = [];

      await planPhase({
        issue: 505,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit,
        log: (type, msg) => logs.push({ type, msg }),
      });

      expect(stub.calls[0].prompt).toContain('Add eval runner');
      expect(stub.calls[0].prompt).toContain('Measure the current prompt.');
      const workRequestLog = logs.find((l) => l.type === 'work_request');
      expect(workRequestLog?.msg).toContain('github-issue:on-par/software-factory#505');
    });

    it('uses an injected workSources registry instead of octokit', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
      tempDirs.add(worktree);
      const specPath = join(worktree, 'issue-505.md');
      const stub = new StubModelExecutor({
        scripts: { plan: [{ output: '---\nroute: codex\n---\n# Spec\n' }] },
      });
      const router = new ModelRouter(models, routes, false, stub);
      let issuesGetCalled = false;
      const octokit: any = {
        rest: {
          issues: {
            get: async () => {
              issuesGetCalled = true;
              return { data: { title: 'Should not be used', body: 'Should not be used.' } };
            },
            update: async () => {
              throw new Error('local briefs must not update GitHub');
            },
          },
        },
      };
      const workSources = new WorkSourceRegistry().register({
        kind: 'local-brief',
        resolve: async () => ({
          id: 'local-brief:1',
          kind: 'local-brief',
          title: 'Local brief title',
          brief: 'Local brief body.',
          acceptanceCriteria: [],
        }),
      });

      await planPhase({
        issue: 505,
        repo: 'on-par/software-factory',
        worktree,
        specPath,
        router,
        constitution: null,
        octokit,
        log: () => {},
        workSources,
        workSource: { kind: 'local-brief', params: {} },
        enforceReadiness: true,
      });

      expect(stub.calls[0].prompt).toContain('Local brief title');
      expect(stub.calls[0].prompt).toContain('Local brief body.');
      expect(issuesGetCalled).toBe(false);
    });
  });
});
