import { describe, expect, it } from 'vitest';

import {
  agentEventPhase,
  createAgentEventStream,
  summarizeForEvent,
  type AgentEvent,
  type AgentEventNormalizer,
} from './agent-events.js';
import { normalizeClaudeStreamLine } from './claude-stream-events.js';
import { normalizeCodexStreamLine } from './codex-stream-events.js';

const CTX = { phase: 'build', at: '2026-01-01T00:00:00.000Z' };

const lineNormalizer: AgentEventNormalizer = (line, ctx) => [{ ...ctx, kind: 'text', summary: line }];

describe('summarizeForEvent', () => {
  it('caps long summaries with a truncated marker', () => {
    const raw = 'a'.repeat(250);
    expect(summarizeForEvent(raw)).toBe(`${'a'.repeat(200)}…[truncated 50 chars]`);
  });

  it('collapses whitespace and keeps short text whole', () => {
    expect(summarizeForEvent('  one\n two\t three ')).toBe('one two three');
  });
});

describe('agentEventPhase', () => {
  it.each([
    ['plan', 'plan'],
    ['build_claude', 'build'],
    ['build_codex', 'build'],
    ['check_design', 'check'],
    ['review_pr', 'check'],
    ['security_review', 'check'],
    ['classify_pr', 'ship'],
    ['readiness_enrich', 'readiness_enrich'],
  ] as const)('maps %s to %s', (task, phase) => {
    expect(agentEventPhase(task as Parameters<typeof agentEventPhase>[0])).toBe(phase);
  });
});

describe('agent event normalizers', () => {
  it('summarizes a tool call from its main input only', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { description: 'd'.repeat(300), timeout: 5, command: 'npm test' },
          },
        ],
      },
    });
    const events = normalizeClaudeStreamLine(line, CTX);
    expect(events).toEqual([{ ...CTX, kind: 'tool_call', name: 'Bash', summary: 'npm test' }]);
  });

  it('skips bad and unknown lines without throwing', () => {
    const lines = ['not json', '', '42', '[]', 'null', '{"type":"mystery"}'];
    for (const normalize of [normalizeClaudeStreamLine, normalizeCodexStreamLine]) {
      for (const line of lines) expect(normalize(line, CTX)).toEqual([]);
      const seen: AgentEvent[] = [];
      const stream = createAgentEventStream(normalize, { phase: 'build', onEvent: (e) => seen.push(e) });
      stream.onStdout(`${lines.join('\n')}\n`);
      stream.flush();
      expect(seen).toEqual([]);
    }
  });
});

describe('createAgentEventStream', () => {
  const now = () => new Date('2026-01-01T00:00:00.000Z');

  it('emits each event as its line arrives across split chunks', () => {
    const seen: AgentEvent[] = [];
    const stream = createAgentEventStream(lineNormalizer, { phase: 'plan', onEvent: (e) => seen.push(e), now });
    stream.onStdout('{"a":');
    expect(seen).toEqual([]);
    stream.onStdout('1}\npartial');
    expect(seen.map((e) => e.summary)).toEqual(['{"a":1}']);
    stream.flush();
    expect(seen.map((e) => e.summary)).toEqual(['{"a":1}', 'partial']);
    expect(seen[0]).toMatchObject({ phase: 'plan', at: '2026-01-01T00:00:00.000Z' });
  });

  it('a throwing subscriber does not stop the stream', () => {
    const later: AgentEvent[] = [];
    let first = true;
    const stream = createAgentEventStream(lineNormalizer, {
      phase: 'plan',
      now,
      onEvent: (e) => {
        if (first) {
          first = false;
          throw new Error('boom');
        }
        later.push(e);
      },
    });
    stream.onStdout('one\ntwo\nthree\n');
    expect(later.map((e) => e.summary)).toEqual(['two', 'three']);
  });
});
