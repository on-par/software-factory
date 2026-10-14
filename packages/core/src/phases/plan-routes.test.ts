import { describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { buildPlanPrompt } from './plan.js';
import { resolveReworkRoute, resolveRunnableBuildRoute, runnableBuildRoutes } from './plan-routes.js';

const base: ModelsConfig = {
  version: 1,
  models: {},
  tiers: {},
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const declared: ModelsConfig = {
  ...base,
  models: {
    'my-model': {
      provider: 'custom',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'my-agent',
    },
  },
  tiers: { worker: ['my-model'] },
  harnesses: {
    'my-agent': { command: 'my-agent {model}', prompt: 'stdin', output: 'stdout', agentic: true, usage: 'none' },
  },
};

const undeclared: ModelsConfig = {
  ...base,
  models: {
    'claude-worker': {
      provider: 'anthropic',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: ['claude'],
      envKey: null,
    },
    'codex-worker': {
      provider: 'openai',
      tier: 'worker',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: ['codex'],
      envKey: null,
      codex: true,
    },
  },
  tiers: { worker: ['claude-worker', 'codex-worker'] },
};

const routes: RoutesConfig = {
  version: 1,
  routes: {
    build_claude: { tier: 'worker', description: 'stub', requires: 'claude' },
    build_codex: { tier: 'worker', description: 'stub', requires: 'codex' },
    build_command: { tier: 'worker', description: 'stub', requires: 'command' },
  },
};

const makeRouter = (models: ModelsConfig) =>
  new ModelRouter(models, routes, false, new StubModelExecutor({ scripts: {} }));

describe('resolveReworkRoute', () => {
  it('keeps command and the pin when the pin is on a declared agentic harness', () => {
    expect(resolveReworkRoute(makeRouter(declared), 'command', 'my-model')).toEqual({
      route: 'command',
      rerouted: false,
      modelOverride: 'my-model',
    });
  });

  it('keeps command without a pin when build_command resolves a declared agentic worker', () => {
    const result = resolveReworkRoute(makeRouter(declared), 'command', undefined);
    expect(result).toMatchObject({ route: 'command', rerouted: false });
    expect(result.modelOverride).toBeUndefined();
  });

  it('reroutes command with no pin and no declared agentic worker to the first runnable route', () => {
    const router = makeRouter(undeclared);
    const result = resolveReworkRoute(router, 'command', undefined);
    expect(result.rerouted).toBe(true);
    expect(result.route).toBe(runnableBuildRoutes(router)[0]);
    expect(result.modelOverride).toBeUndefined();
  });

  it('drops an unfit pin on command', () => {
    const result = resolveReworkRoute(makeRouter(undeclared), 'command', 'claude-worker');
    expect(result.rerouted).toBe(true);
    expect(result.modelOverride).toBeUndefined();
  });

  it('falls back when the router has no registryRef and resolveAll throws', () => {
    const router = {
      resolveAll: () => {
        throw new Error('nope');
      },
    };
    expect(resolveReworkRoute(router, 'command', 'my-model')).toEqual({ route: 'claude', rerouted: true });
  });

  it('delegates codex/claude/opencode unchanged', () => {
    const router = makeRouter(undeclared);
    const runnable = runnableBuildRoutes(router);
    expect(resolveReworkRoute(router, 'codex', 'x')).toEqual({
      ...resolveRunnableBuildRoute('codex', runnable),
      modelOverride: 'x',
    });
    const rerouted = resolveReworkRoute(router, 'opencode', 'x');
    expect(rerouted.rerouted).toBe(true);
    expect(rerouted.modelOverride).toBeUndefined();
  });
});

describe('command route offering (#2874)', () => {
  const promptWith = (runnableRoutes?: ReturnType<typeof runnableBuildRoutes>) =>
    buildPlanPrompt({
      issue: 1,
      issueTitle: 't',
      issueBody: 'b',
      specPath: '/s.md',
      constitutionCtx: '',
      runnableRoutes,
    });

  it('reports command last only when build_command is runnable', () => {
    expect(runnableBuildRoutes(makeRouter(declared)).at(-1)).toBe('command');
    expect(runnableBuildRoutes(makeRouter(undeclared))).not.toContain('command');
  });

  it('offers the command bullet when a declared agentic worker makes build_command runnable', () => {
    expect(promptWith(runnableBuildRoutes(makeRouter(declared)))).toContain('route: command —');
  });

  it('hides the command bullet when no declared agentic harness can run build_command', () => {
    expect(promptWith(runnableBuildRoutes(makeRouter(undeclared)))).not.toContain('route: command');
    expect(promptWith()).not.toContain('route: command');
  });

  it('offers command without a runnable note when it is runnable alongside every CLI route', () => {
    const prompt = promptWith(['claude', 'codex', 'opencode', 'command']);
    expect(prompt).toContain('route: command —');
    expect(prompt).not.toContain('Only these routes can run');
  });
});
