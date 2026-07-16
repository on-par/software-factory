import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  await Promise.all([...tempDirs].map(dir => rm(dir, { recursive: true, force: true })));
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
});

describe('planPhase', () => {
  it('passes timeoutSeconds through to the router', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'plan-phase-test-'));
    tempDirs.add(worktree);
    const specPath = join(worktree, 'issue-36.md');
    let captured: number | undefined;
    const stub = new StubModelExecutor({
      scripts: {
        plan: [{
          output: '---\nroute: codex\n---\n# Spec\n',
          effect: (ctx) => { captured = ctx.timeoutSeconds; },
        }],
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
        plan: [{
          output: '---\nroute: codex\n---\n# Spec\n',
        }],
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
        plan: [{
          output: '---\nroute: codex\n---\n# Spec\n',
        }],
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
        plan: [{
          output: '---\nroute: "codex"\n---\n# Spec\n',
        }],
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
        plan: [{
          output: '---\nroute: "codex "\n---\n# Spec\n',
        }],
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
        plan: [{
          output: '---\nroute: codex\n---\n# Fresh Spec\n',
        }],
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
      log: (type, msg) => { logs.push({ type, msg }); },
    });

    expect(result.route).toBe('codex');
    await expect(readFile(specPath, 'utf-8')).resolves.toContain('# Fresh Spec');

    const archived = await readdir(join(worktree, '.archive'));
    expect(archived).toHaveLength(1);
    await expect(readFile(join(worktree, '.archive', archived[0]), 'utf-8')).resolves.toContain('# Stale Spec');
    expect(logs.some(l => l.type === 'plan' && l.msg.startsWith('Archived existing spec before planning:'))).toBe(true);
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
          plan: [{
            output: '---\nroute: claude\n---\n# Spec\n',
          }],
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
          log: (type, msg) => { logs.push({ type, msg }); },
        });

        expect(result.route).toBe('codex');
        expect(logs).toContainEqual({ type: 'warn', msg: 'local-only mode requires a local Codex harness — forcing route to codex' });

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
          plan: [{
            output: '---\nroute: codex\n---\n# Spec\n',
          }],
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
        log: (type, msg) => { logs.push({ type, msg }); },
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
          plan: [{
            output: '---\nroute: codex\n---\n# Spec\n',
          }],
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
        plan: [
          { fail: 'usage_cap' },
          { output: '---\nroute: codex\n---\n# Spec\n' },
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
    const logCalls: Array<[string, string, ({ failoverReason?: string } | undefined)?]> = [];

    await planPhase({
      issue: 40,
      repo: 'on-par/software-factory',
      worktree,
      specPath,
      router,
      constitution: null,
      octokit,
      log: (type, msg, extra) => { logCalls.push([type, msg, extra]); },
    });

    expect(logCalls).toContainEqual(['failover', expect.stringContaining('usage_cap'), { failoverReason: 'usage_cap' }]);
  });
});
