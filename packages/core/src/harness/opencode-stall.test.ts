import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import { describeFailureDetail } from '../router/failure-detail.js';
import { makeContractRequest } from './contract.js';
import { HarnessError } from './index.js';
import { describeOpenCodeAttempt, OpenCodeHarness } from './opencode.js';

const modelsConfig: ModelsConfig = {
  version: 1,
  models: {
    'opencode-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'opencode',
      providerModel: 'anthropic/claude-sonnet-5',
    },
  },
  tiers: { boss: ['opencode-model'] },
  failover: { triggers: ['rate_limit', 'unavailable', 'auth'], maxRetries: 2, cooldownMs: 0 },
  routingRules: {},
};
const registry = new ModelRegistry(modelsConfig);

const nd = (...events: object[]) => events.map((e) => JSON.stringify(e)).join('\n');
const tokens = { input: 1, output: 7, reasoning: 0, cache: { read: 0, write: 0 } };
const toolCallOnlyLastStep = nd(
  { type: 'step_start' },
  { type: 'text', part: { text: 'earlier narration' } },
  { type: 'step_finish', part: { reason: 'tool-calls', tokens } },
  { type: 'step_start' },
  { type: 'step_finish', part: { reason: 'tool-calls', tokens } },
);
const truncated = nd({ type: 'step_start' }, { type: 'text', part: { text: 'partial' } });

describe('OpenCodeHarness stall watch', () => {
  it('throws a stalled timeout HarnessError when the stall watch fires before the phase timeout', async () => {
    const killed: number[] = [];
    let rejectExec: (e: Error) => void = () => {};
    const execFn = (cmd: string, opts: any) => {
      if (cmd === 'opencode --version') return Promise.resolve({ stdout: '', stderr: '' });
      opts.onPgid(123);
      return new Promise<{ stdout: string; stderr: string }>((_, reject) => {
        rejectExec = reject;
      });
    };
    let clock = 0;
    const onPgid = vi.fn();
    const harness = new OpenCodeHarness(execFn, undefined, undefined, {
      stallSeconds: 60,
      intervalMs: 5,
      probe: async () => ({ cpuSeconds: 1, tcpConnections: 0 }),
      now: () => (clock += 60_000),
      kill: async (pgid) => {
        killed.push(pgid);
        rejectExec(Object.assign(new Error('killed'), { signal: 'SIGTERM', stdout: '', stderr: '' }));
      },
    });

    const err: any = await harness
      .run(makeContractRequest({ model: 'opencode-model', registry, timeoutSeconds: 7200, onPgid }))
      .catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('timeout');
    expect(err.details.stalled).toBe(true);
    expect(err.message).toContain('stalled');
    expect(killed).toEqual([123]);
    expect(onPgid).toHaveBeenCalledWith(123);
  });
});

describe('OpenCodeHarness empty-output diagnostics', () => {
  it('records per-attempt diagnostics and a trace file when both attempts return empty output', async () => {
    const harness = new OpenCodeHarness(async () => ({ stdout: toolCallOnlyLastStep, stderr: 'warn' }));
    const err: any = await harness
      .run(makeContractRequest({ model: 'opencode-model', registry, prompt: 'rework it' }))
      .catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('empty_response');
    for (const part of ['task=', 'promptBytes=', 'a1:', 'a2:', 'lastFinish=', 'events=']) {
      expect(err.details.diagnostic).toContain(part);
    }
    const trace = JSON.parse(readFileSync(err.details.tracePath, 'utf8'));
    expect(trace.attempts).toHaveLength(2);
    const line = describeFailureDetail(err);
    expect(line).toContain('diagnostic=');
    expect(line).toContain('trace=');
  });
});

describe('describeOpenCodeAttempt', () => {
  it('reports no events for empty stdout', () => {
    expect(describeOpenCodeAttempt(1, '', '')).toContain('events=0');
  });

  it('reports finished=false for a truncated run', () => {
    expect(describeOpenCodeAttempt(1, truncated, '')).toContain('finished=false');
  });

  it('reports a tool-call-only last step with earlier text', () => {
    const line = describeOpenCodeAttempt(2, toolCallOnlyLastStep, 'e');
    expect(line).toContain('a2:');
    expect(line).toContain('lastFinish=tool-calls');
    expect(line).toContain('finished=true');
    expect(line).toContain('steps=2');
    expect(line).toContain('outTokens=14');
    expect(line).toContain('earlierTextChars=17');
  });
});
