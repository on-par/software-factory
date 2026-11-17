import { redactText } from '../filing/redact.js';
import type { TaskType } from '../types/index.js';

export interface AgentEvent {
  phase: string;
  kind: 'tool_call' | 'tool_result' | 'skill' | 'mcp' | 'text' | 'result';
  name?: string;
  summary: string;
  at: string;
}

export type AgentEventNormalizer = (line: string, ctx: { phase: string; at: string }) => AgentEvent[];

const SUMMARY_MAX = 200;

export function summarizeForEvent(raw: string): string {
  const s = redactText(raw).replace(/\s+/g, ' ').trim();
  if (s.length <= SUMMARY_MAX) return s;
  return `${s.slice(0, SUMMARY_MAX)}…[truncated ${s.length - SUMMARY_MAX} chars]`;
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
      for (const e of normalize(line, { phase: opts.phase, at: now().toISOString() })) {
        try {
          opts.onEvent(e);
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

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseJsonObject(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isObj(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
