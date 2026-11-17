import type { AgentEvent } from './agent-events.js';
import { isObj, parseJsonObject, summarizeForEvent } from './agent-events.js';

type Ctx = { phase: string; at: string };
type Obj = Record<string, unknown>;

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
const MCP_NAME = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/;

function mainInput(input: Obj): string | undefined {
  for (const key of MAIN_INPUT_KEYS) {
    const value = input[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function contentBlocks(parsed: Obj): Obj[] {
  const content = isObj(parsed.message) ? parsed.message.content : undefined;
  return Array.isArray(content) ? content.filter(isObj) : [];
}

function toolUseEvent(block: Obj, ctx: Ctx): AgentEvent {
  const name = block.name as string;
  const input = isObj(block.input) ? block.input : {};
  const base = { phase: ctx.phase };
  if (name === 'Skill') {
    const skill = [input.skill, input.command].find((v) => typeof v === 'string') ?? 'Skill';
    return { ...base, kind: 'skill', name: skill as string, summary: summarizeForEvent(skill as string), at: ctx.at };
  }
  const mcp = MCP_NAME.exec(name);
  if (mcp) {
    const full = `${mcp[1]}.${mcp[2]}`;
    return { ...base, kind: 'mcp', name: full, summary: summarizeForEvent(mainInput(input) ?? full), at: ctx.at };
  }
  return { ...base, kind: 'tool_call', name, summary: summarizeForEvent(mainInput(input) ?? name), at: ctx.at };
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item): item is Obj => isObj(item) && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text as string)
    .join(' ');
}

function resultSummary(parsed: Obj): string {
  const subtype = typeof parsed.subtype === 'string' ? parsed.subtype : undefined;
  if (parsed.is_error === true) {
    return `error: ${subtype ?? 'unknown'}${typeof parsed.result === 'string' ? ` ${parsed.result}` : ''}`;
  }
  return `${subtype ?? 'done'} (${String(parsed.num_turns ?? '?')} turns, ${String(parsed.duration_ms ?? '?')}ms)`;
}

export function normalizeClaudeStreamLine(line: string, ctx: Ctx): AgentEvent[] {
  const parsed = parseJsonObject(line);
  if (!parsed) return [];
  const events: AgentEvent[] = [];
  if (parsed.type === 'assistant') {
    for (const block of contentBlocks(parsed)) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        events.push({ phase: ctx.phase, kind: 'text', summary: summarizeForEvent(block.text), at: ctx.at });
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        events.push(toolUseEvent(block, ctx));
      }
    }
  } else if (parsed.type === 'user') {
    for (const block of contentBlocks(parsed).filter((b) => b.type === 'tool_result')) {
      const text = toolResultText(block.content);
      const status = block.is_error === true ? 'error' : 'ok';
      events.push({
        phase: ctx.phase,
        kind: 'tool_result',
        summary: summarizeForEvent(`${status}${text ? `: ${text}` : ''}`),
        at: ctx.at,
      });
    }
  } else if (parsed.type === 'result') {
    events.push({ phase: ctx.phase, kind: 'result', summary: summarizeForEvent(resultSummary(parsed)), at: ctx.at });
  }
  return events;
}
