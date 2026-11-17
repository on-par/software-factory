import type { AgentEvent } from '@on-par/factory-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatAgentEventLine, printAgentEvent } from './agent-event-line.js';

const EVENT: AgentEvent = {
  phase: 'build',
  kind: 'tool_call',
  name: 'Read',
  summary: 'a.ts',
  at: '2026-01-01T00:00:00.000Z',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('agent event line', () => {
  it('prints one [factory] agent-event line with the event JSON', () => {
    const printed: unknown[][] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      printed.push(args);
    });
    printAgentEvent(EVENT);
    expect(printed).toEqual([
      [
        '[factory] agent-event {"phase":"build","kind":"tool_call","name":"Read","summary":"a.ts","at":"2026-01-01T00:00:00.000Z"}',
      ],
    ]);
    expect(JSON.parse(formatAgentEventLine(EVENT).slice('[factory] agent-event '.length))).toEqual(EVENT);
  });

  it('routes through console.log so --json mode keeps stdout clean', () => {
    const viaLog: string[] = [];
    const viaWrite: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      viaLog.push(line);
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      viaWrite.push(String(chunk));
      return true;
    });
    printAgentEvent(EVENT);
    expect(viaLog).toEqual([formatAgentEventLine(EVENT)]);
    expect(viaWrite).toEqual([]);
  });
});
