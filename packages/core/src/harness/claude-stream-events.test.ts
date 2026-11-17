import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeClaudeStreamLine } from './claude-stream-events.js';

const AT = '2026-01-01T00:00:00.000Z';
const FIXTURE = join(__dirname, '../../../../scripts/fixtures/agents/recordings/claude-cli/stream-events.stdout');

describe('normalizeClaudeStreamLine', () => {
  it('maps the recorded claude stream to agent events', () => {
    const events = readFileSync(FIXTURE, 'utf8')
      .split('\n')
      .flatMap((line) => normalizeClaudeStreamLine(line, { phase: 'build', at: AT }));
    expect(events.every((e) => e.phase === 'build' && e.at === AT)).toBe(true);
    expect(events.map(({ kind, name, summary }) => ({ kind, name, summary }))).toEqual([
      { kind: 'text', name: undefined, summary: 'Reading the config first.' },
      { kind: 'tool_call', name: 'Read', summary: '<path>' },
      { kind: 'skill', name: 'verify', summary: 'verify' },
      { kind: 'mcp', name: 'github.get_issue', summary: 'issue 12' },
      { kind: 'tool_result', name: undefined, summary: 'ok: export const a = 1;' },
      { kind: 'tool_result', name: undefined, summary: 'error: not found' },
      { kind: 'tool_call', name: 'Bash', summary: `echo ${'x'.repeat(195)}…[truncated 35 chars]` },
      { kind: 'result', name: undefined, summary: 'success (3 turns, 12000ms)' },
    ]);
  });

  it('ignores partial-message deltas', () => {
    const line = JSON.stringify({ type: 'stream_event', event: { delta: { text: 'x' } } });
    expect(normalizeClaudeStreamLine(line, { phase: 'build', at: AT })).toEqual([]);
  });

  it('summarizes an error result', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'too long' });
    expect(normalizeClaudeStreamLine(line, { phase: 'build', at: AT })[0]?.summary).toBe(
      'error: error_max_turns too long',
    );
  });
});
