import { describe, expect, it } from 'vitest';

import type { AgentEvent } from './agent-events.js';
import { CodexCliHarness } from './codex-cli.js';
import { makeContractRequest } from './contract.js';

const LINES = [
  JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } }),
  JSON.stringify({ type: 'turn.completed', usage: { output_tokens: 3 } }),
];

describe('CodexCliHarness agent events', () => {
  it('delivers codex agent events before the run resolves', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = new CodexCliHarness(
      async (_cmd, opts) => {
        for (const line of LINES) opts.onStdout?.(`${line}\n`);
        await gate;
        return { stdout: `${LINES.join('\n')}\n`, stderr: '' };
      },
      { readFile: async () => 'codex output' },
    );
    const events: AgentEvent[] = [];
    const run = harness.run(makeContractRequest({ onEvent: (e) => void events.push(e) }));
    const settledEarly = await Promise.race([
      run.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 20)),
    ]);
    expect(events.map((e) => [e.phase, e.kind, e.name])).toEqual([
      ['build', 'tool_call', 'shell'],
      ['build', 'result', undefined],
    ]);
    expect(settledEarly).toBe(false);
    release();
    expect((await run).output).toBe('codex output');
  });
});
