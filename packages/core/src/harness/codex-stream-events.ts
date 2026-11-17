import { asObject, parseJsonObject, scalarText, summarizeForEvent, type AgentEvent } from './agent-events.js';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function normalizeCodexStreamLine(line: string, ctx: { phase: string; at: string }): AgentEvent[] {
  const msg = parseJsonObject(line);
  if (!msg) return [];
  const { phase, at } = ctx;
  const one = (kind: AgentEvent['kind'], summary: string, name?: string): AgentEvent[] => [
    { phase, kind, ...(name === undefined ? {} : { name }), summary: summarizeForEvent(summary), at },
  ];

  if (msg.type === 'turn.completed') {
    return one('result', `turn completed (${scalarText(asObject(msg.usage)?.output_tokens, '?')} output tokens)`);
  }
  if (msg.type === 'turn.failed') {
    return one('result', `error: ${str(asObject(msg.error)?.message) || 'turn failed'}`);
  }
  const item = asObject(msg.item);
  if (!item || (msg.type !== 'item.started' && msg.type !== 'item.completed')) return [];
  const started = msg.type === 'item.started';

  switch (item.type) {
    case 'command_execution':
      if (started) return one('tool_call', str(item.command), 'shell');
      return one(
        'tool_result',
        `${item.exit_code === 0 || item.status === 'completed' ? 'ok' : 'error'}: exit ${scalarText(item.exit_code, '?')}`,
      );
    case 'mcp_tool_call': {
      const name = `${str(item.server)}.${str(item.tool)}`;
      if (started) return one('mcp', name, name);
      return one('tool_result', item.status !== 'failed' && !item.error ? 'ok' : 'error');
    }
    case 'file_change': {
      if (started) return [];
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return one('tool_call', changes.map((c) => str(asObject(c)?.path)).join(', '), 'file_change');
    }
    case 'web_search':
      return started ? one('tool_call', str(item.query), 'web_search') : [];
    case 'agent_message':
      return started ? [] : one('text', str(item.text));
    default:
      return [];
  }
}
