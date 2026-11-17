import { describe, expect, it } from 'vitest';

import type { AgentEvent } from './agent-events.js';
import { ClaudeCliHarness } from './claude-cli.js';
import { makeContractRequest } from './contract.js';
import { HarnessError } from './index.js';

const textLine = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const toolLine = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
});
const resultLine = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'DONE',
    num_turns: 2,
    duration_ms: 1000,
    duration_api_ms: 900,
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 20 },
    ...over,
  });

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('ClaudeCliHarness agent events', () => {
  it('delivers agent events before the run resolves', async () => {
    const gate = deferred();
    const written = deferred();
    const lines = [textLine('starting'), toolLine];
    const harness = new ClaudeCliHarness(async (_cmd, opts) => {
      opts.onStdout?.(`${lines[0]}\n${lines[1]}\n`);
      written.release();
      await gate.promise;
      return { stdout: `${lines.join('\n')}\n${resultLine()}\n`, stderr: '' };
    });
    const events: AgentEvent[] = [];
    let resolved = false;
    const run = harness.run(makeContractRequest({ task: 'build_claude', onEvent: (e) => events.push(e) })).then((r) => {
      resolved = true;
      return r;
    });
    await written.promise;
    await new Promise((r) => setTimeout(r, 20));
    expect(events.map((e) => ({ phase: e.phase, kind: e.kind, summary: e.summary }))).toEqual([
      { phase: 'build', kind: 'text', summary: 'starting' },
      { phase: 'build', kind: 'tool_call', summary: 'npm test' },
    ]);
    expect(resolved).toBe(false);
    gate.release();
    expect((await run).output).toBe('DONE');
  });

  it('flushes a trailing unterminated line when the process exits', async () => {
    const harness = new ClaudeCliHarness(async (_cmd, opts) => {
      opts.onStdout?.(resultLine());
      return { stdout: resultLine(), stderr: '' };
    });
    const events: AgentEvent[] = [];
    await harness.run(makeContractRequest({ task: 'plan', onEvent: (e) => events.push(e) }));
    expect(events.map((e) => ({ phase: e.phase, kind: e.kind }))).toEqual([{ phase: 'plan', kind: 'result' }]);
  });

  it('keeps result parsing and usage unchanged when onEvent is set', async () => {
    const stdout = `${textLine('hi')}\n${toolLine}\n${resultLine()}\n`;
    const exec = async () => ({ stdout, stderr: '' });
    const plain = await new ClaudeCliHarness(exec).run(makeContractRequest());
    const withEvents = await new ClaudeCliHarness(exec).run(makeContractRequest({ onEvent: () => {} }));
    expect(withEvents).toEqual(plain);
    expect(withEvents.usage?.outputTokens).toBe(20);

    const failing = `${textLine('hi')}\n${resultLine({ is_error: true, subtype: 'error_max_turns' })}\n`;
    const reasonOf = async (req: ReturnType<typeof makeContractRequest>) => {
      try {
        await new ClaudeCliHarness(async () => ({ stdout: failing, stderr: '' })).run(req);
      } catch (err) {
        return err instanceof HarnessError ? err.reason : 'not a HarnessError';
      }
      return 'no error';
    };
    const expected = await reasonOf(makeContractRequest());
    expect(expected).not.toBe('no error');
    expect(await reasonOf(makeContractRequest({ onEvent: () => {} }))).toBe(expected);
  });
});
