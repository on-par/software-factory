import { asObject, parseJsonObject, scalarText, summarizeForEvent, type AgentEvent } from './agent-events.js';

const MAIN_INPUT_KEYS = [
  'file_path',
  'notebook_path',
  'path',
  'command',
  'pattern',
  'url',
  'query',
  'description',
  'prompt',
];
const MCP_NAME = /^mcp__(.+?)__(.+)$/;

type Obj = Record<string, unknown>;

function contentBlocks(value: unknown): Obj[] {
  const content = asObject(value)?.content;
  if (!Array.isArray(content)) return [];
  return content.map(asObject).filter((b): b is Obj => b !== undefined);
}

function mainInput(input: Obj): string | undefined {
  for (const key of MAIN_INPUT_KEYS) {
    const v = input[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((item) => {
      const o = asObject(item);
      return o?.type === 'text' && typeof o.text === 'string' ? [o.text] : [];
    })
    .join(' ');
}

export function normalizeClaudeStreamLine(line: string, ctx: { phase: string; at: string }): AgentEvent[] {
  const msg = parseJsonObject(line);
  if (!msg) return [];
  const { phase, at } = ctx;
  const events: AgentEvent[] = [];

  if (msg.type === 'assistant') {
    for (const block of contentBlocks(msg.message)) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        events.push({ phase, kind: 'text', summary: summarizeForEvent(block.text), at });
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const input = asObject(block.input) ?? {};
        const mcp = MCP_NAME.exec(block.name);
        if (block.name === 'Skill') {
          const skill = scalarText(input.skill ?? input.command, 'Skill');
          events.push({ phase, kind: 'skill', name: skill, summary: summarizeForEvent(skill), at });
        } else if (mcp) {
          const name = `${mcp[1]}.${mcp[2]}`;
          events.push({ phase, kind: 'mcp', name, summary: summarizeForEvent(mainInput(input) ?? name), at });
        } else {
          events.push({
            phase,
            kind: 'tool_call',
            name: block.name,
            summary: summarizeForEvent(mainInput(input) ?? block.name),
            at,
          });
        }
      }
    }
  } else if (msg.type === 'user') {
    for (const block of contentBlocks(msg.message)) {
      if (block.type !== 'tool_result') continue;
      const text = resultText(block.content);
      const summary = `${block.is_error === true ? 'error' : 'ok'}${text ? `: ${text}` : ''}`;
      events.push({ phase, kind: 'tool_result', summary: summarizeForEvent(summary), at });
    }
  } else if (msg.type === 'result') {
    const summary =
      msg.is_error === true
        ? `error: ${scalarText(msg.subtype, 'unknown')}${typeof msg.result === 'string' ? ` ${msg.result}` : ''}`
        : `${scalarText(msg.subtype, 'done')} (${scalarText(msg.num_turns, '?')} turns, ${scalarText(msg.duration_ms, '?')}ms)`;
    events.push({ phase, kind: 'result', summary: summarizeForEvent(summary), at });
  }
  return events;
}
