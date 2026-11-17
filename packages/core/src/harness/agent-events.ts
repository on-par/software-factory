import { isPlainObject } from '../config/index.js';
import { redactText } from '../filing/redact.js';
import { phaseOfTask } from '../kpis/phase.js';
import type { HarnessRequest } from './index.js';

export interface AgentEvent {
  phase: string;
  kind: 'tool_call' | 'tool_result' | 'skill' | 'mcp' | 'text' | 'result';
  name?: string;
  summary: string;
  at: string;
}

type Activity = Pick<AgentEvent, 'kind' | 'name' | 'summary'>;
type Json = Record<string, unknown>;

const SUMMARY_MAX = 200;
const MAIN_INPUT_KEYS = ['file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'query', 'description'];
const MCP_NAME = /^mcp__(.+?)__(.+)$/;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const field = (value: unknown, key: string): unknown => (isPlainObject(value) ? value[key] : undefined);
const joinField = (list: unknown, key: string, sep: string): string =>
  (Array.isArray(list) ? list : []).map((item) => str(field(item, key))).join(sep);

function summarize(raw: string): string {
  const text = redactText(raw).replace(/\s+/g, ' ').trim();
  if (text.length <= SUMMARY_MAX) return text;
  return `${text.slice(0, SUMMARY_MAX)}…[truncated ${text.length - SUMMARY_MAX} chars]`;
}

function claudeToolUse(block: Json): Activity {
  const name = str(block.name);
  const main = MAIN_INPUT_KEYS.map((key) => str(field(block.input, key))).find(Boolean);
  if (name === 'Skill') {
    const skill = str(field(block.input, 'skill')) || str(field(block.input, 'command')) || name;
    return { kind: 'skill', name: skill, summary: skill };
  }
  const mcp = MCP_NAME.exec(name);
  const fullName = mcp ? `${mcp[1]}.${mcp[2]}` : name;
  return { kind: mcp ? 'mcp' : 'tool_call', name: fullName, summary: main ?? fullName };
}

function claudeToolResult(block: Json): Activity {
  const text = typeof block.content === 'string' ? block.content : joinField(block.content, 'text', ' ');
  const status = block.is_error === true ? 'error' : 'ok';
  return { kind: 'tool_result', summary: text.trim() ? `${status}: ${text}` : status };
}

function claudeResult(parsed: Json): string {
  const subtype = str(parsed.subtype);
  if (parsed.is_error === true) return `error: ${subtype || 'unknown'} ${str(parsed.result)}`;
  return `${subtype || 'done'} (${String(parsed.num_turns ?? '?')} turns, ${String(parsed.duration_ms ?? '?')}ms)`;
}

export function claudeActivity(parsed: Json): Activity[] {
  if (parsed.type === 'result') return [{ kind: 'result', summary: claudeResult(parsed) }];
  const content = field(parsed.message, 'content');
  return (Array.isArray(content) ? content.filter(isPlainObject) : []).flatMap((block): Activity[] => {
    if (block.type === 'tool_result') return [claudeToolResult(block)];
    if (parsed.type !== 'assistant') return [];
    if (block.type === 'tool_use') return [claudeToolUse(block)];
    return block.type === 'text' ? [{ kind: 'text', summary: str(block.text) }] : [];
  });
}

export function codexActivity(parsed: Json): Activity[] {
  const item = isPlainObject(parsed.item) ? parsed.item : {};
  const status = item.status === 'failed' || item.error || (item.exit_code ?? 0) !== 0 ? 'error' : 'ok';
  const mcp = `${str(item.server)}.${str(item.tool)}`;
  const tokens = String(field(parsed.usage, 'output_tokens') ?? '?');
  switch (`${str(parsed.type)}:${str(item.type)}`) {
    case 'turn.completed:':
      return [{ kind: 'result', summary: `turn completed (${tokens} output tokens)` }];
    case 'turn.failed:':
      return [{ kind: 'result', summary: `error: ${str(field(parsed.error, 'message')) || 'turn failed'}` }];
    case 'item.started:command_execution':
      return [{ kind: 'tool_call', name: 'shell', summary: str(item.command) }];
    case 'item.completed:command_execution':
      return [{ kind: 'tool_result', summary: `${status}: exit ${String(item.exit_code ?? '?')}` }];
    case 'item.started:mcp_tool_call':
      return [{ kind: 'mcp', name: mcp, summary: mcp }];
    case 'item.completed:mcp_tool_call':
      return [{ kind: 'tool_result', summary: status }];
    case 'item.started:web_search':
      return [{ kind: 'tool_call', name: 'web_search', summary: str(item.query) }];
    case 'item.completed:file_change':
      return [{ kind: 'tool_call', name: 'file_change', summary: joinField(item.changes, 'path', ', ') }];
    case 'item.completed:agent_message':
      return [{ kind: 'text', summary: str(item.text) }];
    default:
      return [];
  }
}

export function agentEventStdout(
  request: Pick<HarnessRequest, 'task' | 'onEvent'>,
  activity: (parsed: Json) => Activity[],
  also?: (chunk: string) => void,
): ((chunk: string) => void) | undefined {
  const { onEvent } = request;
  if (!onEvent) return also;
  const phase = phaseOfTask(request.task) ?? request.task;
  let buffer = '';
  return (chunk) => {
    also?.(chunk);
    const lines = (buffer + chunk).split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line);
        for (const event of isPlainObject(parsed) ? activity(parsed) : []) {
          const summary = summarize(event.summary);
          if (summary) onEvent({ phase, ...event, summary, at: new Date().toISOString() });
        }
      } catch {}
    }
  };
}
