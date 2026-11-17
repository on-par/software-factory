import { describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { AgentEvent } from '../harness/agent-events.js';
import { createAgentEventForwarder } from '../run/agent-event-forwarder.js';
import { ModelRouter } from './index.js';
import { StubModelExecutor } from './stub.js';

const MODELS: ModelsConfig = {
  version: 1,
  routingRules: {},
  tiers: { worker: ['w'] },
  failover: { maxRetries: 0, cooldownMs: 0, triggers: [] },
  models: {
    w: {
      tier: 'worker',
      provider: 'custom',
      envKey: null,
      contextWindow: 2000,
      capabilities: [],
      costPerMtokOutput: 0,
      costPerMtokInput: 0,
    },
  },
};
const ROUTES: RoutesConfig = { version: 1, routes: { plan: { description: 'stub', tier: 'worker' } } };

const EVENT: AgentEvent = { phase: 'plan', kind: 'text', summary: 'thinking', at: '2026-01-01T00:00:00.000Z' };

function routerEmitting(event: AgentEvent): ModelRouter {
  const stub = new StubModelExecutor({
    scripts: { plan: [{ output: 'PLAN', effect: (ctx) => ctx.onAgentEvent?.(event) }] },
  });
  return new ModelRouter(MODELS, ROUTES, false, stub);
}

describe('ModelRouter agent event sink', () => {
  it('forwards harness agent events to the registered sink', async () => {
    const router = routerEmitting(EVENT);
    const seen: AgentEvent[] = [];
    router.setAgentEventSink((e) => seen.push(e));
    const result = await router.run('plan', 'prompt', { worktree: '/tmp/wt' });
    expect(result.output).toBe('PLAN');
    expect(seen).toEqual([EVENT]);
  });

  it('a throwing sink does not fail the run', async () => {
    const router = routerEmitting(EVENT);
    const seen: AgentEvent[] = [];
    router.setAgentEventSink(
      createAgentEventForwarder(
        () => () => {
          throw new Error('log boom');
        },
        (e) => seen.push(e),
      ),
    );
    expect((await router.run('plan', 'prompt', { worktree: '/tmp/wt' })).output).toBe('PLAN');
    expect(seen).toEqual([EVENT]);
  });
});
