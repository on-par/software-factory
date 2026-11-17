import type { AgentEvent } from './agent-events.js';
import { isObj, parseJsonObject, summarizeForEvent } from './agent-events.js';

type Ctx = { phase: string; at: string };
type Obj = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function itemEvent(started: boolean, item: Obj): Omit<AgentEvent, 'phase' | 'at'> | undefined {
  switch (item.type) {
    case 'command_execution': {
      if (started) return { kind: 'tool_call', name: 'shell', summary: str(item.command) };
      const ok = item.exit_code === 0 || item.status === 'completed';
      return { kind: 'tool_result', summary: `${ok ? 'ok' : 'error'}: exit ${String(item.exit_code ?? '?')}` };
    }
    case 'mcp_tool_call': {
      const name = `${str(item.server)}.${str(item.tool)}`;
      if (started) return { kind: 'mcp', name, summary: name };
      const ok = item.status !== 'failed' && !item.error;
      return { kind: 'tool_result', summary: ok ? 'ok' : 'error' };
    }
    case 'file_change': {
      if (started) return undefined;
      const changes = Array.isArray(item.changes) ? item.changes.filter(isObj) : [];
      return { kind: 'tool_call', name: 'file_change', summary: changes.map((c) => str(c.path)).join(', ') };
    }
    case 'web_search':
      return started ? { kind: 'tool_call', name: 'web_search', summary: str(item.query) } : undefined;
    case 'agent_message':
      return started ? undefined : { kind: 'text', summary: str(item.text) };
    default:
      return undefined;
  }
}

function turnSummary(parsed: Obj): string | undefined {
  if (parsed.type === 'turn.completed') {
    const usage = isObj(parsed.usage) ? parsed.usage : {};
    return `turn completed (${String(usage.output_tokens ?? '?')} output tokens)`;
  }
  if (parsed.type === 'turn.failed') {
    const error = isObj(parsed.error) ? parsed.error : {};
    return `error: ${str(error.message) || 'turn failed'}`;
  }
  return undefined;
}

export function normalizeCodexStreamLine(line: string, ctx: Ctx): AgentEvent[] {
  const parsed = parseJsonObject(line);
  if (!parsed) return [];
  const turn = turnSummary(parsed);
  if (turn !== undefined) return [{ phase: ctx.phase, kind: 'result', summary: summarizeForEvent(turn), at: ctx.at }];
  if ((parsed.type !== 'item.started' && parsed.type !== 'item.completed') || !isObj(parsed.item)) return [];
  const partial = itemEvent(parsed.type === 'item.started', parsed.item);
  if (!partial) return [];
  return [
    {
      phase: ctx.phase,
      kind: partial.kind,
      ...(partial.name === undefined ? {} : { name: partial.name }),
      summary: summarizeForEvent(partial.summary),
      at: ctx.at,
    },
  ];
}
