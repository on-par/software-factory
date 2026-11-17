import { describe, expect, it } from 'vitest';

import type { EventKind } from '../events/kinds.js';
import type { AgentEvent } from '../harness/agent-events.js';
import { createAgentEventForwarder } from './agent-event-forwarder.js';

const EVENT: AgentEvent = {
  phase: 'build',
  kind: 'tool_call',
  name: 'Read',
  summary: 'a.ts',
  at: '2026-01-01T00:00:00.000Z',
};

function recorder() {
  const logged: { phase: string | undefined; type: EventKind; msg: string }[] = [];
  const events = (phase?: string) => (type: EventKind, msg: string) => {
    logged.push({ phase, type, msg });
  };
  return { logged, events };
}

describe('createAgentEventForwarder', () => {
  it('appends each event to the run log as agent-event', () => {
    const { logged, events } = recorder();
    const forward = createAgentEventForwarder(events);
    forward(EVENT);
    forward({ ...EVENT, phase: 'check' });
    expect(logged.map((l) => ({ phase: l.phase, type: l.type }))).toEqual([
      { phase: 'build', type: 'agent-event' },
      { phase: 'check', type: 'agent-event' },
    ]);
    expect(JSON.parse(logged[0].msg)).toEqual(EVENT);
  });

  it('calls the onAgentEvent subscriber', () => {
    const { events } = recorder();
    const seen: AgentEvent[] = [];
    createAgentEventForwarder(events, (e) => seen.push(e))(EVENT);
    expect(seen).toEqual([EVENT]);
  });

  it('a throwing subscriber does not break forwarding', () => {
    const { logged, events } = recorder();
    const forward = createAgentEventForwarder(events, () => {
      throw new Error('subscriber boom');
    });
    forward(EVENT);
    forward(EVENT);
    expect(logged).toHaveLength(2);
  });

  it('a throwing log still reaches the subscriber', () => {
    const seen: AgentEvent[] = [];
    const forward = createAgentEventForwarder(
      () => () => {
        throw new Error('log boom');
      },
      (e) => seen.push(e),
    );
    forward(EVENT);
    expect(seen).toEqual([EVENT]);
  });
});
