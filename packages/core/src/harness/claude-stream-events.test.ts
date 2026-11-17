import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { normalizeClaudeStreamLine } from './claude-stream-events.js';

const CTX = { phase: 'build', at: '2026-01-01T00:00:00.000Z' };
const FIXTURE = fileURLToPath(
  new URL('../../../../scripts/fixtures/agents/recordings/claude-cli/stream-events.stdout', import.meta.url),
);

describe('normalizeClaudeStreamLine', () => {
  it('maps the recorded claude stream to agent events', () => {
    const events = readFileSync(FIXTURE, 'utf8')
      .split('\n')
      .flatMap((line) => normalizeClaudeStreamLine(line, CTX));
    expect(events.every((e) => e.phase === 'build' && e.at === CTX.at)).toBe(true);
    expect(events.map(({ kind, name, summary }) => ({ kind, name, summary }))).toEqual([
      { kind: 'text', name: undefined, summary: 'I will read the file first.' },
      { kind: 'tool_call', name: 'Read', summary: '<path>' },
      { kind: 'skill', name: 'verify', summary: 'verify' },
      { kind: 'mcp', name: 'github.get_issue', summary: 'issue 12' },
      { kind: 'tool_result', name: undefined, summary: 'ok: export const a = 1;' },
      { kind: 'tool_result', name: undefined, summary: 'error: not found' },
      { kind: 'tool_call', name: 'Bash', summary: `echo ${'x'.repeat(195)}…[truncated ${5 + 230 - 200} chars]` },
      { kind: 'result', name: undefined, summary: 'success (3 turns, 12000ms)' },
    ]);
  });

  it('ignores partial-message deltas', () => {
    const line = '{"type":"stream_event","event":{"type":"content_block_delta"}}';
    expect(normalizeClaudeStreamLine(line, CTX)).toEqual([]);
  });

  it('reports an error result with its subtype and message', () => {
    const line = '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"ran out"}';
    expect(normalizeClaudeStreamLine(line, CTX)).toEqual([
      { ...CTX, kind: 'result', summary: 'error: error_max_turns ran out' },
    ]);
  });
});
