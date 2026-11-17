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
    const lines: unknown[][] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void lines.push(args));
    printAgentEvent(EVENT);
    expect(lines).toEqual([[`[factory] agent-event ${JSON.stringify(EVENT)}`]]);
    const line = String(lines[0]![0]);
    expect(JSON.parse(line.slice('[factory] agent-event '.length))).toEqual(EVENT);
    expect(formatAgentEventLine(EVENT)).toBe(line);
  });

  it('routes through console.log so --json mode keeps stdout clean', () => {
    const logged: string[] = [];
    const stdout: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logged.push(String(args[0])));
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    printAgentEvent(EVENT);
    expect(logged).toHaveLength(1);
    expect(stdout).toEqual([]);
  });
});
