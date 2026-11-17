import { writeFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from './agent-events.js';
import { CodexCliHarness } from './codex-cli.js';
import { makeContractRequest } from './contract.js';

describe('CodexCliHarness agent events', () => {
  it('delivers codex agent events before the run resolves', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = JSON.stringify({
      type: 'item.started',
      item: { id: 'i0', type: 'command_execution', command: 'npm test' },
    });
    const done = JSON.stringify({ type: 'turn.completed', usage: { output_tokens: 7 } });
    const harness = new CodexCliHarness(async (cmd, opts) => {
      opts.onStdout?.(`${started}\n`);
      await gate;
      opts.onStdout?.(done);
      await writeFile(/-o '([^']+)'/.exec(cmd)![1], 'codex output');
      return { stdout: `${started}\n${done}\n`, stderr: '' };
    });
    const events: AgentEvent[] = [];
    let resolved = false;
    const run = harness.run(makeContractRequest({ onEvent: (e) => events.push(e) })).then((r) => {
      resolved = true;
      return r;
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events.map((e) => ({ phase: e.phase, kind: e.kind, name: e.name, summary: e.summary }))).toEqual([
      { phase: 'build', kind: 'tool_call', name: 'shell', summary: 'npm test' },
    ]);
    expect(resolved).toBe(false);
    release();
    expect((await run).output).toBe('codex output');
    expect(events.map((e) => e.summary)).toEqual(['npm test', 'turn completed (7 output tokens)']);
  });
});
