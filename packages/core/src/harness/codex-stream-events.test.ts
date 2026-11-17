import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeCodexStreamLine } from './codex-stream-events.js';

const AT = '2026-01-01T00:00:00.000Z';
const FIXTURE = join(__dirname, '../../../../scripts/fixtures/agents/recordings/codex/stream-events.stdout');

describe('normalizeCodexStreamLine', () => {
  it('maps the recorded codex stream to agent events', () => {
    const events = readFileSync(FIXTURE, 'utf8')
      .split('\n')
      .flatMap((line) => normalizeCodexStreamLine(line, { phase: 'build', at: AT }));
    expect(events.every((e) => e.phase === 'build' && e.at === AT)).toBe(true);
    expect(events.map(({ kind, name, summary }) => ({ kind, name, summary }))).toEqual([
      { kind: 'tool_call', name: 'shell', summary: 'ls src' },
      { kind: 'tool_result', name: undefined, summary: 'ok: exit 0' },
      { kind: 'mcp', name: 'github.get_issue', summary: 'github.get_issue' },
      { kind: 'tool_result', name: undefined, summary: 'ok' },
      { kind: 'tool_call', name: 'file_change', summary: '<path>, <path>' },
      { kind: 'text', name: undefined, summary: 'Implemented the change and committed it.' },
      { kind: 'result', name: undefined, summary: 'turn completed (5 output tokens)' },
    ]);
  });

  it('maps failures, searches and failed turns', () => {
    const run = (value: unknown) => normalizeCodexStreamLine(JSON.stringify(value), { phase: 'plan', at: AT });
    expect(
      run({ type: 'item.completed', item: { type: 'command_execution', exit_code: 2, status: 'failed' } })[0]?.summary,
    ).toBe('error: exit 2');
    expect(run({ type: 'item.completed', item: { type: 'mcp_tool_call', status: 'failed' } })[0]?.summary).toBe(
      'error',
    );
    expect(run({ type: 'item.started', item: { type: 'web_search', query: 'vitest' } })[0]).toMatchObject({
      name: 'web_search',
      summary: 'vitest',
    });
    expect(run({ type: 'turn.failed', error: { message: 'bad' } })[0]?.summary).toBe('error: bad');
    expect(run({ type: 'turn.failed' })[0]?.summary).toBe('error: turn failed');
  });
});
