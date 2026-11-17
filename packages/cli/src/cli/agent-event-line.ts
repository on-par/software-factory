import type { AgentEvent } from '@on-par/factory-core';

const AGENT_EVENT_LINE_PREFIX = '[factory] agent-event ';

export function formatAgentEventLine(event: AgentEvent): string {
  return `${AGENT_EVENT_LINE_PREFIX}${JSON.stringify(event)}`;
}

export function printAgentEvent(event: AgentEvent): void {
  console.log(formatAgentEventLine(event));
}
