import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
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
  },
};

const tempDirs = new Set<string>();
let prevFactoryCodex: string | undefined;

beforeEach(() => {
  prevFactoryCodex = process.env.FACTORY_CODEX;
  delete process.env.FACTORY_CODEX;
});

afterEach(async () => {
  if (prevFactoryCodex === undefined) delete process.env.FACTORY_CODEX;
  else process.env.FACTORY_CODEX = prevFactoryCodex;
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
});

describe('planPhase', () => {
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

  describe('FACTORY_CODEX kill-switch', () => {
    it('forces route to codex when FACTORY_LOCAL_ONLY=1 so builds use the local agent harness', async () => {
      const prevLocalOnly = process.env.FACTORY_LOCAL_ONLY;
      process.env.FACTORY_LOCAL_ONLY = '1';

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

      try {
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
        });

        expect(result.route).toBe('codex');
        expect(logs).toContainEqual({
          type: 'warn',
          msg: 'local-only mode requires a local Codex harness — forcing route to codex',
        });

        const persisted = await readFile(specPath, 'utf-8');
        expect(persisted).toContain('route: codex');
        expect(persisted).not.toContain('route: claude');
      } finally {
        if (prevLocalOnly === undefined) delete process.env.FACTORY_LOCAL_ONLY;
        else process.env.FACTORY_LOCAL_ONLY = prevLocalOnly;
      }
    });

    it('forces route to claude and logs a warn when FACTORY_CODEX=0', async () => {
      process.env.FACTORY_CODEX = '0';

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
      });

      expect(result.route).toBe('claude');
      expect(logs).toContainEqual({ type: 'warn', msg: 'codex unavailable — falling back to claude' });

      const persisted = await readFile(specPath, 'utf-8');
      expect(persisted).toContain('route: claude');
      expect(persisted).not.toContain('route: codex');
    });

    it('keeps route codex when FACTORY_CODEX is unset', async () => {
      delete process.env.FACTORY_CODEX;

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
    const router = new ModelRouter(models, routes, false, stub);
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
});
