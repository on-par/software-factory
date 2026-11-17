import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../harness/agent-events.js';
import { createAgentEventForwarder } from '../run/agent-event-forwarder.js';
import { makeStubModelsConfig, makeStubRoutesConfig } from '../test-support/index.js';
import { ModelRouter } from './index.js';
import { StubModelExecutor } from './stub.js';

const EVENT: AgentEvent = { phase: 'plan', kind: 'text', summary: 'hello', at: '2026-01-01T00:00:00.000Z' };

function routerWith() {
  const stub = new StubModelExecutor({
    scripts: { plan: [{ output: 'plan output', effect: (ctx) => ctx.onAgentEvent?.(EVENT) }] },
  });
  return new ModelRouter(makeStubModelsConfig(), makeStubRoutesConfig(), false, stub);
}

describe('ModelRouter agent event sink', () => {
  it('forwards harness agent events to the registered sink', async () => {
    const router = routerWith();
    const seen: AgentEvent[] = [];
    router.setAgentEventSink((e) => void seen.push(e));
    await router.run('plan', 'p', { worktree: '/tmp/wt', timeoutSeconds: 60 });
    expect(seen).toEqual([EVENT]);
  });

  it('a throwing sink does not fail the run', async () => {
    const router = routerWith();
    const logged: string[] = [];
    router.setAgentEventSink(
      createAgentEventForwarder(
        () => () => {
          throw new Error('log down');
        },
        (e) => void logged.push(e.summary),
      ),
    );
    const out = await router.run('plan', 'p', { worktree: '/tmp/wt', timeoutSeconds: 60 });
    expect(out.output).toBe('plan output');
    expect(logged).toEqual(['hello']);
  });
});
