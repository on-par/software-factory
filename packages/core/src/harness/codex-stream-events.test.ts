import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { normalizeCodexStreamLine } from './codex-stream-events.js';

const CTX = { phase: 'build', at: '2026-01-01T00:00:00.000Z' };
const FIXTURE = fileURLToPath(
  new URL('../../../../scripts/fixtures/agents/recordings/codex/stream-events.stdout', import.meta.url),
);

describe('normalizeCodexStreamLine', () => {
  it('maps the recorded codex stream to agent events', () => {
    const events = readFileSync(FIXTURE, 'utf8')
      .split('\n')
      .flatMap((line) => normalizeCodexStreamLine(line, CTX));
    expect(events.map(({ kind, name, summary }) => ({ kind, name, summary }))).toEqual([
      { kind: 'tool_call', name: 'shell', summary: 'npm test' },
      { kind: 'tool_result', name: undefined, summary: 'ok: exit 0' },
      { kind: 'mcp', name: 'github.get_issue', summary: 'github.get_issue' },
      { kind: 'tool_result', name: undefined, summary: 'ok' },
      { kind: 'tool_call', name: 'file_change', summary: '<path>, <path>' },
      { kind: 'text', name: undefined, summary: 'Implemented the change and committed it.' },
      { kind: 'result', name: undefined, summary: 'turn completed (5 output tokens)' },
    ]);
  });

  it('reports a failed turn', () => {
    expect(normalizeCodexStreamLine('{"type":"turn.failed","error":{"message":"boom"}}', CTX)).toEqual([
      { ...CTX, kind: 'result', summary: 'error: boom' },
    ]);
  });
});
