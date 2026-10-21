import { appendFile, mkdir, writeFile as realWriteFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '@on-par/factory-core/testing';
import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import type { CodexRolloutUsage } from './codex-cli.js';
import { CodexCliHarness } from './codex-cli.js';
import { startCodexLiveUsage } from './codex-live-usage.js';
import { makeContractRequest } from './contract.js';
import type { HarnessLiveUsage } from './index.js';

const THREAD = '019ff914-ffab-7d32-9e8d-2b202a31c34f';
const THREAD_LINE = JSON.stringify({ type: 'thread.started', thread_id: THREAD });
const FINAL_STDOUT = `${THREAD_LINE}\n${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 5 } })}`;

const modelsConfig: ModelsConfig = {
  version: 1,
  models: {
    'codex-model': {
      provider: 'openai',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      codex: true,
      codexFlag: '--model gpt-5-codex',
    },
  },
  tiers: { boss: ['codex-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};
const registry = new ModelRegistry(modelsConfig);
const tempDirs = createTempDirs();
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  return tempDirs.cleanup();
});

function outFileFromCmd(cmd: string): string {
  const match = cmd.match(/-o '([^']+)'/);
  if (!match) throw new Error(`could not find outFile in cmd: ${cmd}`);
  return match[1];
}

function tokenEvent(input: number, output: number, total: number): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 20 },
        total_token_usage: { input_tokens: total - 1, output_tokens: 1, total_tokens: total },
        model_context_window: 272000,
      },
    },
  });
}

async function makeRollout(): Promise<{ home: string; file: string }> {
  const home = await tempDirs.make('codex-home-');
  const dir = join(home, 'sessions', '2026', '10', '19');
  await mkdir(dir, { recursive: true });
  return { home, file: join(dir, `rollout-x-${THREAD}.jsonl`) };
}

describe('CodexCliHarness live usage', () => {
  it('codex reports running usage while the session runs (#3264 call-183 case)', async () => {
    const { home, file } = await makeRollout();
    const events = [
      [100, 10, 110],
      [200, 20, 330],
      [300, 30, 660],
      [400, 40, 1100],
      [500, 50, 1650],
    ] as const;
    const counts: number[] = [];
    const payloads: HarnessLiveUsage[] = [];
    const exec = async (cmd: string, opts: any) => {
      const mid = Math.floor(THREAD_LINE.length / 2);
      opts.onStdout(THREAD_LINE.slice(0, mid));
      opts.onStdout(`${THREAD_LINE.slice(mid)}\n`);
      await realWriteFile(
        file,
        `${events
          .slice(0, 2)
          .map((e) => tokenEvent(e[0], e[1], e[2]))
          .join('\n')}\n`,
      );
      await vi.waitFor(() => expect(counts.at(-1)).toBe(2));
      await appendFile(
        file,
        `${events
          .slice(2)
          .map((e) => tokenEvent(e[0], e[1], e[2]))
          .join('\n')}\n`,
      );
      await vi.waitFor(() => expect(counts.at(-1)).toBe(5));
      await realWriteFile(outFileFromCmd(cmd), 'CODEX OUTPUT');
      return { stdout: FINAL_STDOUT, stderr: '' };
    };
    await new CodexCliHarness(exec, {}, { liveUsageIntervalMs: 5 }).run(
      makeContractRequest({
        model: 'codex-model',
        registry,
        env: { CODEX_HOME: home },
        onUsage: (u) => {
          counts.push(u.calls);
          payloads.push(u);
        },
      }),
    );
    expect(counts.at(-1)).toBe(5);
    expect(new Set(counts).size).toBe(counts.length);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(payloads.at(-1)).toMatchObject({
      inputTokens: events.reduce((s, e) => s + e[0], 0),
      outputTokens: events.reduce((s, e) => s + e[1], 0),
      calls: 5,
      numTurns: 5,
      peakInputTokens: 500,
    });
  });

  it('without onUsage execFn gets no onStdout and nothing is read before exec settles', async () => {
    const { home, file } = await makeRollout();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    let keys: string[] = [];
    const exec = async (cmd: string, opts: any) => {
      expect('onStdout' in opts).toBe(false);
      keys = Object.keys(opts);
      await realWriteFile(file, `${tokenEvent(100, 10, 110)}\n`);
      await realWriteFile(outFileFromCmd(cmd), 'CODEX OUTPUT');
      return { stdout: FINAL_STDOUT, stderr: '' };
    };
    const result = await new CodexCliHarness(exec).run(
      makeContractRequest({ model: 'codex-model', registry, env: { CODEX_HOME: home } }),
    );
    expect(keys).toEqual(['timeoutMs', 'maxBuffer', 'env', 'onPgid']);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 5, numTurns: 1, peakInputTokens: 100 });
  });

  it('a missing rollout never calls onUsage and leaves the result unchanged', async () => {
    const home = await tempDirs.make('codex-home-');
    const exec = async (cmd: string, opts: any) => {
      opts.onStdout?.(`${THREAD_LINE}\n`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await realWriteFile(outFileFromCmd(cmd), 'CODEX OUTPUT');
      return { stdout: FINAL_STDOUT, stderr: '' };
    };
    const harness = new CodexCliHarness(exec, {}, { liveUsageIntervalMs: 5 });
    const onUsage = vi.fn();
    const base = { model: 'codex-model', registry, env: { CODEX_HOME: home } };
    const withLive = await harness.run(makeContractRequest({ ...base, onUsage }));
    const without = await harness.run(makeContractRequest(base));
    expect(onUsage).not.toHaveBeenCalled();
    expect(withLive).toEqual(without);
  });
});

describe('startCodexLiveUsage', () => {
  const usage = (n: number): CodexRolloutUsage => ({
    calls: Array.from({ length: n }, () => ({ inputTokens: 10, outputTokens: 1, rawInputTokens: 10 })),
    numTurns: n,
    peakInputTokens: 10,
  });

  it('stop() ends polling and drops an in-flight read', async () => {
    vi.useFakeTimers();
    let resolveRead: (u: CodexRolloutUsage) => void = () => {};
    const read = vi.fn(() => new Promise<CodexRolloutUsage | undefined>((r) => (resolveRead = r)));
    const onUsage = vi.fn();
    const live = startCodexLiveUsage({ onUsage, intervalMs: 10, locate: async () => '/r', read });
    live.onStdout(`${THREAD_LINE}\n`);
    await vi.advanceTimersByTimeAsync(10);
    expect(read).toHaveBeenCalledTimes(1);
    live.stop();
    live.stop();
    resolveRead(usage(3));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('skips rejected locate/read, does not re-report an unchanged count and survives a throwing onUsage', async () => {
    vi.useFakeTimers();
    const locate = vi.fn().mockRejectedValueOnce(new Error('no')).mockResolvedValue('/r');
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('bad'))
      .mockResolvedValueOnce(usage(1))
      .mockResolvedValueOnce(usage(1))
      .mockResolvedValueOnce(usage(2));
    const onUsage = vi.fn(() => {
      throw new Error('boom');
    });
    const live = startCodexLiveUsage({ onUsage, intervalMs: 10, locate, read });
    await vi.advanceTimersByTimeAsync(50);
    expect(onUsage).not.toHaveBeenCalled();
    live.onStdout(`not json\n${THREAD_LINE}`);
    await vi.advanceTimersByTimeAsync(10);
    expect(locate).not.toHaveBeenCalled();
    live.onStdout('\n');
    await vi.advanceTimersByTimeAsync(100);
    expect(onUsage.mock.calls.map((c: any[]) => c[0].calls)).toEqual([1, 2]);
    live.stop();
  });
});
