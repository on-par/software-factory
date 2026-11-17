import { redactText } from '../filing/redact.js';
import type { TaskType } from '../types/index.js';

const SUMMARY_MAX = 200;

export interface AgentEvent {
  phase: string;
  kind: 'tool_call' | 'tool_result' | 'skill' | 'mcp' | 'text' | 'result';
  name?: string;
  summary: string;
  at: string;
}

export type AgentEventNormalizer = (line: string, ctx: { phase: string; at: string }) => AgentEvent[];

export function summarizeForEvent(raw: string): string {
  const s = redactText(raw).replace(/\s+/g, ' ').trim();
  if (s.length <= SUMMARY_MAX) return s;
  return `${s.slice(0, SUMMARY_MAX)}…[truncated ${s.length - SUMMARY_MAX} chars]`;
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseJsonObject(line: string): Record<string, unknown> | undefined {
  try {
    return asObject(JSON.parse(line));
  } catch {
    return undefined;
  }
}

export function scalarText(value: unknown, fallback: string): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

export function agentEventPhase(task: TaskType): string {
  if (task === 'plan') return 'plan';
  if (task.startsWith('build')) return 'build';
  if (task.startsWith('check_') || task === 'review_pr' || task === 'security_review') return 'check';
  if (task === 'classify_pr') return 'ship';
  return task;
}

export function createAgentEventStream(
  normalize: AgentEventNormalizer,
  opts: { phase: string; onEvent: (event: AgentEvent) => void; now?: () => Date },
): { onStdout: (chunk: string) => void; flush: () => void } {
  const now = opts.now ?? (() => new Date());
  let buffer = '';
  const emitLine = (line: string): void => {
    if (line.trim() === '') return;
    try {
      for (const event of normalize(line, { phase: opts.phase, at: now().toISOString() })) {
        try {
          opts.onEvent(event);
        } catch {}
      }
    } catch {}
  };
  return {
    onStdout(chunk) {
      const parts = (buffer + chunk).split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) emitLine(line);
    },
    flush() {
      const rest = buffer;
      buffer = '';
      emitLine(rest);
    },
  };
}
