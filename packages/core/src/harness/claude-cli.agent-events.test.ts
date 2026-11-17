import { describe, expect, it } from 'vitest';

import type { AgentEvent } from './agent-events.js';
import { ClaudeCliHarness, type ClaudeExecFn } from './claude-cli.js';
import { makeContractRequest } from './contract.js';
import { HarnessError } from './index.js';

const TOOL_LINE = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
});
const result = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    num_turns: 1,
    duration_ms: 5,
    usage: { input_tokens: 10, output_tokens: 2 },
    ...extra,
  });
const STDOUT = `${TOOL_LINE}\n${result()}\n`;

function deferred() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('ClaudeCliHarness agent events', () => {
  it('delivers agent events before the run resolves', async () => {
    const gate = deferred();
    const exec: ClaudeExecFn = async (_cmd, opts) => {
      opts.onStdout?.(`${TOOL_LINE}\n`);
      opts.onStdout?.(`${result()}\n`);
      await gate.promise;
      return { stdout: STDOUT, stderr: '' };
    };
    const events: AgentEvent[] = [];
    let resolved = false;
    const run = new ClaudeCliHarness(exec)
      .run(makeContractRequest({ task: 'build_claude', onEvent: (e) => void events.push(e) }))
      .then((r) => {
        resolved = true;
        return r;
      });
    await new Promise((r) => setTimeout(r, 20));
    expect(events.map((e) => e.kind)).toEqual(['tool_call', 'result']);
    expect(events[0]).toMatchObject({ phase: 'build', name: 'Bash', summary: 'ls' });
    expect(resolved).toBe(false);
    gate.release();
    await run;
    expect(resolved).toBe(true);
  });

  it('keeps result parsing and usage unchanged when onEvent is set', async () => {
    const exec: ClaudeExecFn = async (_cmd, opts) => {
      opts.onStdout?.(STDOUT);
      return { stdout: STDOUT, stderr: '' };
    };
    const plain = await new ClaudeCliHarness(exec).run(makeContractRequest());
    const withEvents = await new ClaudeCliHarness(exec).run(makeContractRequest({ onEvent: () => {} }));
    expect(withEvents).toEqual(plain);
    expect(withEvents.output).toBe('done');
    expect(withEvents.usage).toBeDefined();
  });

  it('keeps the same HarnessError reason for an is_error result', async () => {
    const failing = `${result({ is_error: true, subtype: 'error_during_execution', result: 'rate limit exceeded' })}\n`;
    const exec: ClaudeExecFn = async (_cmd, opts) => {
      opts.onStdout?.(failing);
      return { stdout: failing, stderr: '' };
    };
    const reasonOf = async (onEvent?: () => void) => {
      try {
        await new ClaudeCliHarness(exec).run(makeContractRequest({ onEvent }));
      } catch (err) {
        return err instanceof HarnessError ? err.reason : 'other';
      }
      return 'none';
    };
    const without = await reasonOf();
    expect(without).not.toBe('none');
    expect(await reasonOf(() => {})).toBe(without);
  });
});
