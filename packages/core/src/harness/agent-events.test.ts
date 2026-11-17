import { describe, expect, it } from 'vitest';

import type { TaskType } from '../types/index.js';
import type { AgentEvent } from './agent-events.js';
import { agentEventPhase, createAgentEventStream, summarizeForEvent } from './agent-events.js';
import { normalizeClaudeStreamLine } from './claude-stream-events.js';
import { normalizeCodexStreamLine } from './codex-stream-events.js';

const CTX = { phase: 'build', at: '2026-01-01T00:00:00.000Z' };
const BAD_LINES = ['not json', '', '42', '[]', 'null', '{"type":"mystery"}'];

function collector() {
  const events: AgentEvent[] = [];
  return { events, onEvent: (e: AgentEvent) => void events.push(e) };
}

describe('summarizeForEvent', () => {
  it('caps long summaries with a truncated marker', () => {
    const out = summarizeForEvent('a'.repeat(250));
    expect(out).toBe(`${'a'.repeat(200)}…[truncated 50 chars]`);
  });

  it('collapses whitespace', () => {
    expect(summarizeForEvent('  a\n\n b\t c ')).toBe('a b c');
  });
});

describe('agentEventPhase', () => {
  it.each([
    ['plan', 'plan'],
    ['build_claude', 'build'],
    ['build', 'build'],
    ['check_tests', 'check'],
    ['review_pr', 'check'],
    ['security_review', 'check'],
    ['classify_pr', 'ship'],
    ['classify_issue', 'classify_issue'],
  ])('maps %s to %s', (task, phase) => {
    expect(agentEventPhase(task as TaskType)).toBe(phase);
  });
});

describe('normalizers on bad input', () => {
  it('summarizes a tool call from its main input only', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'ls -la', description: 'x'.repeat(300), extra: 'y' } },
        ],
      },
    });
    expect(normalizeClaudeStreamLine(line, CTX)).toEqual([
      { phase: 'build', kind: 'tool_call', name: 'Bash', summary: 'ls -la', at: CTX.at },
    ]);
  });

  it('skips bad and unknown lines without throwing', () => {
    const { events, onEvent } = collector();
    for (const line of BAD_LINES) {
      expect(normalizeClaudeStreamLine(line, CTX)).toEqual([]);
      expect(normalizeCodexStreamLine(line, CTX)).toEqual([]);
    }
    const stream = createAgentEventStream(normalizeClaudeStreamLine, { phase: 'build', onEvent });
    stream.onStdout(`${BAD_LINES.join('\n')}\n`);
    stream.flush();
    expect(events).toEqual([]);
  });
});

describe('createAgentEventStream', () => {
  const line = JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1, duration_ms: 5 });

  it('emits each event as its line arrives across split chunks', () => {
    const { events, onEvent } = collector();
    const stream = createAgentEventStream(normalizeClaudeStreamLine, {
      phase: 'plan',
      onEvent,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    stream.onStdout(line.slice(0, 10));
    expect(events).toEqual([]);
    stream.onStdout(`${line.slice(10)}\n`);
    expect(events).toEqual([
      { phase: 'plan', kind: 'result', summary: 'success (1 turns, 5ms)', at: '2026-01-01T00:00:00.000Z' },
    ]);
    stream.onStdout(line);
    expect(events).toHaveLength(1);
    stream.flush();
    expect(events).toHaveLength(2);
    stream.flush();
    expect(events).toHaveLength(2);
  });

  it('a throwing subscriber does not stop the stream', () => {
    const second = collector();
    let first = true;
    const stream = createAgentEventStream(normalizeClaudeStreamLine, {
      phase: 'plan',
      onEvent: (e) => {
        if (first) {
          first = false;
          throw new Error('boom');
        }
        second.onEvent(e);
      },
    });
    stream.onStdout(`${line}\n${line}\n`);
    expect(second.events).toHaveLength(1);
  });
});
