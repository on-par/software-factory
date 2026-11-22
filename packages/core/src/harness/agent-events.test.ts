import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ExecFn } from '../utils/exec.js';
import { agentEventStdout, claudeActivity, codexActivity, copilotActivity, type AgentEvent } from './agent-events.js';
import { ClaudeCliHarness } from './claude-cli.js';
import { CodexCliHarness } from './codex-cli.js';
import { makeContractRequest } from './contract.js';

type Activity = typeof claudeActivity;
const recording = (agent: string) =>
  readFileSync(join(__dirname, `../../../../scripts/fixtures/agents/recordings/${agent}/stream-events.stdout`), 'utf8');
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const result = line({ type: 'turn.completed', usage: { output_tokens: 1 } });

function stream(activity: Activity, stdout: string, onEvent?: (event: AgentEvent) => void) {
  const events: AgentEvent[] = [];
  agentEventStdout({ task: 'plan', onEvent: onEvent ?? ((e) => void events.push(e)) }, activity)?.(stdout);
  return events;
}

describe('agent event normalizers', () => {
  it.each([
    [
      'claude-cli',
      claudeActivity,
      [
        ['text', undefined, 'Reading the config first.'],
        ['tool_call', 'Read', '<path>'],
        ['skill', 'verify', 'verify'],
        ['mcp', 'github.get_issue', 'issue 12'],
        ['tool_result', undefined, 'ok: export const a = 1;'],
        ['tool_result', undefined, 'error: not found'],
        ['tool_call', 'Bash', `echo ${'x'.repeat(195)}…[truncated 35 chars]`],
        ['result', undefined, 'success (3 turns, 12000ms)'],
      ],
    ],
    [
      'codex',
      codexActivity,
      [
        ['tool_call', 'shell', 'ls src'],
        ['tool_result', undefined, 'ok: exit 0'],
        ['mcp', 'github.get_issue', 'github.get_issue'],
        ['tool_result', undefined, 'ok'],
        ['tool_call', 'file_change', '<path>, <path>'],
        ['text', undefined, 'Implemented the change and committed it.'],
        ['result', undefined, 'turn completed (5 output tokens)'],
      ],
    ],
  ])('maps the recorded %s stream to agent events', (agent, activity, expected) => {
    expect(stream(activity, recording(agent)).map((e) => [e.kind, e.name, e.summary])).toEqual(expected);
  });

  it.each([
    [{ type: 'item.completed', item: { type: 'command_execution', exit_code: 2, status: 'failed' } }, 'error: exit 2'],
    [{ type: 'item.completed', item: { type: 'mcp_tool_call', status: 'failed' } }, 'error'],
    [{ type: 'item.started', item: { type: 'web_search', query: 'vitest' } }, 'vitest'],
    [{ type: 'turn.failed', error: { message: 'bad' } }, 'error: bad'],
    [{ type: 'turn.failed' }, 'error: turn failed'],
  ])('summarizes the codex line %j', (value, summary) => {
    expect(stream(codexActivity, line(value)).map((e) => e.summary)).toEqual([summary]);
  });

  it('summarizes a claude error result and a tool call by its main input only', () => {
    const error = line({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'too long' });
    const bash = { type: 'tool_use', name: 'Bash', input: { command: 'ls -la', description: 'x'.repeat(300) } };
    const events = stream(claudeActivity, error + line({ type: 'assistant', message: { content: [bash] } }));
    expect(events.map((e) => e.summary)).toEqual(['error: error_max_turns too long', 'ls -la']);
  });

  it.each([claudeActivity, codexActivity])('skips bad and unknown lines', (activity) => {
    const bad = ['not json', '', '42', '[]', 'null', '{"type":"mystery"}', '{"type":"stream_event","event":{}}'];
    expect(stream(activity, `${bad.join('\n')}\n`)).toEqual([]);
  });
});

describe('agentEventStdout', () => {
  it('emits an event once its line completes, with the task phase and arrival time', () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00.000Z') });
    const events: AgentEvent[] = [];
    const write = agentEventStdout({ task: 'check_tests', onEvent: (e) => void events.push(e) }, codexActivity);
    write?.(result.slice(0, 10));
    expect(events).toEqual([]);
    write?.(result.slice(10));
    vi.useRealTimers();
    expect(events).toEqual([
      { phase: 'check', kind: 'result', summary: 'turn completed (1 output tokens)', at: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('keeps streaming after a subscriber throws', () => {
    const seen: string[] = [];
    stream(codexActivity, result + result, (e) => {
      seen.push(e.summary);
      if (seen.length === 1) throw new Error('boom');
    });
    expect(seen).toHaveLength(2);
  });

  it('passes chunks through to another stdout reader', () => {
    const chunks: string[] = [];
    const also = (chunk: string) => void chunks.push(chunk);
    expect(agentEventStdout({ task: 'plan' }, codexActivity, also)).toBe(also);
    agentEventStdout({ task: 'plan', onEvent: () => {} }, codexActivity, also)?.(result);
    expect(chunks).toEqual([result]);
  });
});

describe('harness agent events', () => {
  const bash = { type: 'tool_use', name: 'Bash', input: { command: 'ls' } };
  const claudeStdout =
    line({ type: 'assistant', message: { content: [bash] } }) + line({ type: 'result', result: 'done' });
  const codexStdout = line({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } }) + result;

  it.each([
    ['claude', claudeStdout, (exec: ExecFn) => new ClaudeCliHarness(exec)],
    ['codex', codexStdout, (exec: ExecFn) => new CodexCliHarness(exec, { readFile: async () => 'done' })],
  ])('%s delivers events while the agent is still running', async (_agent, stdout, make) => {
    const events: AgentEvent[] = [];
    let beforeExit: string[] = [];
    const run = make(async (_cmd, opts) => {
      opts.onStdout?.(stdout);
      beforeExit = events.map((e) => `${e.phase} ${e.kind}`);
      return { stdout, stderr: '' };
    }).run(makeContractRequest({ onEvent: (e) => void events.push(e) }));
    expect((await run).output).toBe('done');
    expect(beforeExit).toEqual(['build tool_call', 'build result']);
  });
});

describe('copilotActivity', () => {
  const fixture = (name: string) =>
    readFileSync(join(__dirname, `../__fixtures__/copilot-cli/copilot-cli-synthetic-1.0.114.${name}.jsonl`), 'utf8');
  const summaries = (stdout: string) => stream(copilotActivity, stdout).map((e) => [e.kind, e.name, e.summary]);

  it('maps the success run to tool_call, tool_result, mcp, text and result events (synthetic 1.0.114 fixture)', () => {
    expect(summaries(fixture('success'))).toEqual([
      ['text', undefined, 'Reading the code first.'],
      ['tool_call', 'bash', 'ls src'],
      ['tool_result', undefined, 'ok: index.ts parser.ts'],
      ['mcp', 'example-server.get_item', 'example-server.get_item'],
      ['tool_result', undefined, 'error: item not found'],
      ['tool_call', 'task', 'Review the parser'],
      ['tool_result', undefined, 'ok: The parser handles CRLF.'],
      ['text', undefined, 'Added a unit test for the parser and ran it.'],
      ['result', undefined, 'exit 0'],
    ]);
  });

  it('emits nothing for token deltas, sub-agent messages, usage, session.idle or the fixture note (synthetic 1.0.114 fixture)', () => {
    const silent = /"type":"(fixture\.note|assistant\.message_delta|assistant\.usage|session\.idle)"|"agentId"/;
    const quiet = fixture('success')
      .split('\n')
      .filter((l) => silent.test(l));
    expect(quiet).toHaveLength(9);
    expect(summaries(`${quiet.join('\n')}\n`)).toEqual([]);
  });

  it('maps session.error and a failed result record (synthetic 1.0.114 fixture)', () => {
    expect(summaries(fixture('error-rate-limit'))).toEqual([
      ['result', undefined, 'error: Request was throttled. Try again later.'],
      ['result', undefined, 'exit 1'],
    ]);
  });

  it.each([
    [{ type: 'result', data: { exitCode: 2 } }, 'exit 2'],
    [{ type: 'result' }, 'exit ?'],
    [{ type: 'session.error', data: { errorType: 'quota' } }, 'error: quota'],
    [{ type: 'tool.execution_complete', data: { success: false } }, 'error'],
    [{ type: 'tool.execution_start', data: { toolName: 'bash', arguments: 'raw args' } }, 'raw args'],
  ])('summarizes the copilot line %j', (value, summary) => {
    expect(stream(copilotActivity, line(value)).map((e) => e.summary)).toEqual([summary]);
  });

  it('redacts and truncates a summary (synthetic 1.0.114 fixture shell call with a long, secret-bearing command)', () => {
    const token = `github_pat_${'A'.repeat(40)}`;
    const command = `echo ${token} ${'x'.repeat(300)}`;
    const start =
      fixture('success')
        .split('\n')
        .find((l) => l.includes('"type":"tool.execution_start"')) ?? '';
    const events = stream(copilotActivity, `${start.replace('ls src', command)}\n`);
    expect(events.map((e) => e.name)).toEqual(['bash']);
    expect(events[0]?.summary).not.toContain(token);
    expect(events[0]?.summary).toMatch(/…\[truncated \d+ chars\]$/);
  });

  it('skips bad and unknown lines', () => {
    const bad = ['not json', '', '42', '[]', 'null', '{"type":"mystery"}', '{"type":"session.idle","data":{}}'];
    expect(stream(copilotActivity, `${bad.join('\n')}\n`)).toEqual([]);
  });
});
