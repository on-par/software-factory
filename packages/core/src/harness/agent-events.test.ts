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

describe('copilotActivity (documented session event shapes; unverified against a live transcript)', () => {
  it('maps tool, MCP, message and result events and emits nothing for token deltas', () => {
    const stdout = [
      { type: 'assistant.message_delta', data: { deltaContent: 'Rea' } },
      { type: 'tool.execution_start', data: { toolName: 'view', arguments: { path: 'src/a.ts' } } },
      { type: 'tool.execution_complete', data: { success: true, result: { content: 'export const a = 1;' } } },
      { type: 'tool.execution_start', data: { toolName: 'get_issue', mcpServerName: 'github', arguments: {} } },
      { type: 'tool.execution_complete', data: { success: false, error: { message: 'not found' } } },
      { type: 'tool.execution_start', data: { toolName: 'bash', arguments: 'raw args' } },
      { type: 'tool.execution_complete', data: { success: false } },
      { type: 'assistant.message', data: { content: 'Done.' } },
      { type: 'assistant.message', data: { content: 'sub-agent note', parentToolCallId: 't1' } },
      { type: 'session.error', data: { errorType: 'quota' } },
      { type: 'result', exitCode: 0 },
    ]
      .map(line)
      .join('');
    expect(stream(copilotActivity, stdout).map((e) => [e.kind, e.name, e.summary])).toEqual([
      ['tool_call', 'view', '<path>'],
      ['tool_result', undefined, 'ok: export const a = 1;'],
      ['mcp', 'github.get_issue', 'github.get_issue'],
      ['tool_result', undefined, 'error: not found'],
      ['tool_call', 'bash', 'raw args'],
      ['tool_result', undefined, 'error'],
      ['text', undefined, 'Done.'],
      ['result', undefined, 'error: quota'],
      ['result', undefined, 'exit 0'],
    ]);
  });

  it('redacts and truncates summaries', () => {
    const token = `github_pat_${'A'.repeat(40)}`;
    const command = `echo ${token} ${'x'.repeat(300)}`;
    const events = stream(
      copilotActivity,
      line({ type: 'tool.execution_start', data: { toolName: 'bash', arguments: { command } } }),
    );
    expect(events[0]?.summary).not.toContain(token);
    expect(events[0]?.summary).toMatch(/…\[truncated \d+ chars\]$/);
  });

  it('skips bad and unknown lines', () => {
    const bad = ['not json', '', '42', '[]', 'null', '{"type":"mystery"}', '{"type":"session.idle","data":{}}'];
    expect(stream(copilotActivity, `${bad.join('\n')}\n`)).toEqual([]);
  });
});
