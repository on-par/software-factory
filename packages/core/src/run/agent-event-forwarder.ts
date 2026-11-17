import type { EventKind } from '../events/kinds.js';
import type { AgentEvent } from '../harness/agent-events.js';

export function createAgentEventForwarder(
  events: (phase?: string) => (type: EventKind, msg: string) => void,
  subscriber?: (event: AgentEvent) => void,
): (event: AgentEvent) => void {
  return (event) => {
    try {
      events(event.phase)('agent-event', JSON.stringify(event));
    } catch {}
    if (subscriber) {
      try {
        subscriber(event);
      } catch {}
    }
  };
}
