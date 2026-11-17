import { describe, expect, it } from 'vitest';

import type { EventKind } from '../events/kinds.js';
import type { AgentEvent } from '../harness/agent-events.js';
import { createAgentEventForwarder } from './agent-event-forwarder.js';

const EVENT: AgentEvent = {
  phase: 'build',
  kind: 'tool_call',
  name: 'Bash',
  summary: 'ls',
  at: '2026-01-01T00:00:00.000Z',
};

function logger() {
  const rows: { phase?: string; type: EventKind; msg: string }[] = [];
  return { rows, events: (phase?: string) => (type: EventKind, msg: string) => void rows.push({ phase, type, msg }) };
}

describe('createAgentEventForwarder', () => {
  it('appends each event to the run log as agent-event', () => {
    const { rows, events } = logger();
    createAgentEventForwarder(events)(EVENT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phase: 'build', type: 'agent-event' });
    expect(JSON.parse(rows[0]!.msg)).toEqual(EVENT);
  });

  it('calls the onAgentEvent subscriber', () => {
    const seen: AgentEvent[] = [];
    createAgentEventForwarder(logger().events, (e) => void seen.push(e))(EVENT);
    expect(seen).toEqual([EVENT]);
  });

  it('a throwing subscriber does not break forwarding', () => {
    const { rows, events } = logger();
    const forward = createAgentEventForwarder(events, () => {
      throw new Error('boom');
    });
    forward(EVENT);
    forward(EVENT);
    expect(rows).toHaveLength(2);
  });

  it('a throwing log still reaches the subscriber', () => {
    const seen: AgentEvent[] = [];
    createAgentEventForwarder(
      () => () => {
        throw new Error('log down');
      },
      (e) => void seen.push(e),
    )(EVENT);
    expect(seen).toEqual([EVENT]);
  });
});
