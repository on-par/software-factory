import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile as realWriteFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '@on-par/factory-core/testing';
import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import { CodexCliHarness, locateCodexRollout, readCodexRolloutUsage } from './codex-cli.js';
import { makeContractRequest } from './contract.js';
import { HarnessError } from './index.js';

function outFileFromCmd(cmd: string): string {
  const match = cmd.match(/-o '([^']+)'/);
  if (!match) throw new Error(`could not find outFile in cmd: ${cmd}`);
  return match[1];
}

function tempPathsFromCmd(cmd: string): { outFile: string; tmpFile: string } {
  return { outFile: cmd.match(/ -o '([^']+)'/)![1], tmpFile: cmd.match(/ < '([^']+)'$/)![1] };
}

function expectTempFilesCleanedUp(cmd: string): void {
  const { outFile, tmpFile } = tempPathsFromCmd(cmd);
  expect(existsSync(outFile)).toBe(false);
  expect(existsSync(tmpFile)).toBe(false);
}

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
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
  },
  routingRules: {},
};
const registry = new ModelRegistry(modelsConfig);
const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());

function recordingExec(
  result: { stdout?: string; stderr?: string } = {},
  onCmd?: (cmd: string) => Promise<void> | void,
) {
  const calls: { cmd: string; opts: any }[] = [];
  const fn = async (cmd: string, opts: any) => {
    calls.push({ cmd, opts });
    if (onCmd) await onCmd(cmd);
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { fn, calls };
}
function successExec() {
  return recordingExec({}, async (cmd) => realWriteFile(outFileFromCmd(cmd), 'CODEX OUTPUT'));
}

function tokenEvent(input: number, output: number, total: number, window = 272000): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 20 },
        total_token_usage: { input_tokens: total - 1, output_tokens: 1, total_tokens: total },
        model_context_window: window,
      },
    },
  });
}

describe('readCodexRolloutUsage', () => {
  it('returns distinct per-call usage, peak input and latest valid window', async () => {
    const dir = await tempDirs.make('codex-usage-');
    const file = join(dir, 'rollout.jsonl');
    try {
      await realWriteFile(
        file,
        [
          tokenEvent(27779, 10, 30000),
          tokenEvent(27779, 10, 30000),
          tokenEvent(120001, 20, 150000),
          tokenEvent(198303, 30, 230000, 300000),
        ].join('\n'),
      );
      await expect(readCodexRolloutUsage(file)).resolves.toEqual({
        calls: [
          { inputTokens: 27779, outputTokens: 10, rawInputTokens: 27759, cacheReadTokens: 20 },
          { inputTokens: 120001, outputTokens: 20, rawInputTokens: 119981, cacheReadTokens: 20 },
          { inputTokens: 198303, outputTokens: 30, rawInputTokens: 198283, cacheReadTokens: 20 },
        ],
        numTurns: 3,
        peakInputTokens: 198303,
        contextWindow: 300000,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns complete calls before a truncated last line and sees the completed call on reread', async () => {
    const dir = await tempDirs.make('codex-usage-');
    const file = join(dir, 'rollout.jsonl');
    const first = tokenEvent(10, 2, 12);
    const second = tokenEvent(20, 3, 35);
    const third = tokenEvent(30, 4, 69);
    try {
      await realWriteFile(file, `${first}\n${second}\n{"type":"event_msg","payload":`);
      await expect(readCodexRolloutUsage(file)).resolves.toMatchObject({ numTurns: 2, peakInputTokens: 20 });
      await realWriteFile(file, `${first}\n${second}\n${third}`);
      await expect(readCodexRolloutUsage(file)).resolves.toMatchObject({ numTurns: 3, peakInputTokens: 30 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores unusable records and returns undefined for empty or missing files', async () => {
    const dir = await tempDirs.make('codex-usage-');
    const file = join(dir, 'rollout.jsonl');
    try {
      await realWriteFile(
        file,
        [
          'null',
          '3',
          '{bad',
          JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
          JSON.stringify({ type: 'rate_limits', payload: {} }),
          tokenEvent(-1, 2, 1),
        ].join('\n'),
      );
      await expect(readCodexRolloutUsage(file)).resolves.toBeUndefined();
      await realWriteFile(file, '');
      await expect(readCodexRolloutUsage(file)).resolves.toBeUndefined();
      await expect(readCodexRolloutUsage(join(dir, 'missing'))).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('accepts a complete final event without a newline and omits an unavailable window', async () => {
    const dir = await tempDirs.make('codex-usage-');
    const file = join(dir, 'rollout.jsonl');
    try {
      await realWriteFile(
        file,
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 1, output_tokens: 2 },
              total_token_usage: { total_tokens: 3 },
              model_context_window: 0,
            },
          },
        }),
      );
      await expect(readCodexRolloutUsage(file)).resolves.toEqual({
        calls: [{ inputTokens: 1, outputTokens: 2, rawInputTokens: 1 }],
        numTurns: 1,
        peakInputTokens: 1,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('locateCodexRollout', () => {
  it('finds only an exact thread match under nested session dates and rejects ambiguous matches', async () => {
    const home = await tempDirs.make('codex-home-');
    const thread = '019ff914-ffab-7d32-9e8d-2b202a31c34f';
    const nested = join(home, 'sessions', '2026', '10', '19');
    try {
      await mkdir(nested, { recursive: true });
      const exact = join(nested, `rollout-x-${thread}.jsonl`);
      await realWriteFile(exact, '');
      await realWriteFile(join(nested, `rollout-x-${thread}-other.jsonl`), '');
      await expect(locateCodexRollout(thread, home)).resolves.toBe(exact);
      await realWriteFile(join(nested, `rollout-y-${thread}.jsonl`), '');
      await expect(locateCodexRollout(thread, home)).resolves.toBeUndefined();
      await expect(locateCodexRollout('invalid', home)).resolves.toBeUndefined();
      await expect(locateCodexRollout(thread, join(home, 'missing'))).resolves.toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('CodexCliHarness rollout compatibility', () => {
  it('preserves stdout usage exactly when its thread has no matching rollout', async () => {
    const home = await tempDirs.make('codex-home-');
    const thread = '019ff914-ffab-7d32-9e8d-2b202a31c34f';
    const stdout = `${JSON.stringify({ type: 'thread.started', thread_id: thread })}\n${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 5 } })}`;
    const rec = recordingExec({ stdout }, async (cmd) => realWriteFile(outFileFromCmd(cmd), 'CODEX OUTPUT'));
    try {
      const result = await new CodexCliHarness(rec.fn).run(
        makeContractRequest({ model: 'codex-model', registry, env: { CODEX_HOME: home } }),
      );
      expect(result.output).toBe('CODEX OUTPUT');
      expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 5, rawInputTokens: 80, cacheReadTokens: 20 });
      expect(result.usage).not.toHaveProperty('numTurns');
      expect(result.usage).not.toHaveProperty('peakInputTokens');
      expect(result.usage).not.toHaveProperty('contextWindow');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('uses request CODEX_HOME ahead of the harness environment', async () => {
    const homes = await Promise.all([tempDirs.make('codex-home-request-'), tempDirs.make('codex-home-env-')]);
    const thread = '019ff914-ffab-7d32-9e8d-2b202a31c34f';
    const stdout = `${JSON.stringify({ type: 'thread.started', thread_id: thread })}\n${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 5 } })}`;
    const rec = recordingExec({ stdout }, async (cmd) => realWriteFile(outFileFromCmd(cmd), 'CODEX OUTPUT'));
    try {
      for (const [home, window] of [
        [homes[0], 200000],
        [homes[1], 300000],
      ] as const) {
        const sessions = join(home, 'sessions', '2026', '10', '19');
        await mkdir(sessions, { recursive: true });
        await realWriteFile(join(sessions, `rollout-x-${thread}.jsonl`), tokenEvent(50, 2, 52, window));
      }
      const result = await new CodexCliHarness(rec.fn, {}, { env: { CODEX_HOME: homes[1] } }).run(
        makeContractRequest({ model: 'codex-model', registry, env: { CODEX_HOME: homes[0] } }),
      );
      expect(result.usage?.contextWindow).toBe(200000);
      const blankHomeThread = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      const blankHomeStdout = `${JSON.stringify({ type: 'thread.started', thread_id: blankHomeThread })}\n${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 5 } })}`;
      const blankHomeExec = recordingExec({ stdout: blankHomeStdout }, async (cmd) =>
        realWriteFile(outFileFromCmd(cmd), 'CODEX OUTPUT'),
      );
      const blankHome = await new CodexCliHarness(blankHomeExec.fn, {}, { env: { CODEX_HOME: homes[1] } }).run(
        makeContractRequest({ model: 'codex-model', registry, env: { CODEX_HOME: '' } }),
      );
      expect(blankHome.usage).not.toHaveProperty('numTurns');
    } finally {
      await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
    }
  });
});

describe('CodexCliHarness usage parsing', () => {
  it('parses usage from a real turn.completed event (AC 1)', async () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"019ff914-ffab-7d32-9e8d-2b202a31c34f"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
      '{"type":"turn.completed","usage":{"input_tokens":15785,"cached_input_tokens":9984,"output_tokens":5,"reasoning_output_tokens":0}}',
    ].join('\n');
    const rec = recordingExec({ stdout }, async (cmd) => {
      await realWriteFile(outFileFromCmd(cmd), 'CODEX OUTPUT');
    });
    const harness = new CodexCliHarness(rec.fn);

    const result = await harness.run(
      makeContractRequest({
        model: 'codex-model',
        registry,
        prompt: 'build it',
        env: { CODEX_HOME: '/nonexistent-codex-home' },
      }),
    );

    expect(result.output).toBe('CODEX OUTPUT');
    expect(result.usage).toEqual({
      inputTokens: 15785,
      outputTokens: 5,
      rawInputTokens: 5801,
      cacheReadTokens: 9984,
    });
    expect(result.usage).not.toHaveProperty('cacheCreationTokens');
    expect(result.usage).not.toHaveProperty('costUsd');
    expect(result.usage).not.toHaveProperty('numTurns');
  });

  it('sums usage across multiple turn.completed events', async () => {
    const stdout = [
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10,"cached_input_tokens":40}}',
      '{"type":"turn.completed","usage":{"input_tokens":200,"output_tokens":20,"cached_input_tokens":60}}',
    ].join('\n');
    const rec = recordingExec({ stdout }, async (cmd) => {
      await realWriteFile(outFileFromCmd(cmd), 'CODEX OUTPUT');
    });
    const harness = new CodexCliHarness(rec.fn);

    const result = await harness.run(makeContractRequest({ model: 'codex-model', registry, prompt: 'build it' }));

    expect(result.usage).toEqual({
      inputTokens: 300,
      outputTokens: 30,
      rawInputTokens: 200,
      cacheReadTokens: 100,
    });
  });

  it('resolves normally with no usage when stdout has no turn.completed event (AC 3)', async () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"019ff914-ffab-7d32-9e8d-2b202a31c34f"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
    ].join('\n');
    const rec = recordingExec({ stdout }, async (cmd) => {
      await realWriteFile(outFileFromCmd(cmd), 'CODEX OUTPUT');
    });
    const harness = new CodexCliHarness(rec.fn);

    const result = await harness.run(makeContractRequest({ model: 'codex-model', registry, prompt: 'build it' }));

    expect(result.output).toBe('CODEX OUTPUT');
    expect(result.usage).toBeUndefined();
  });

  it('resolves with no usage when counts are malformed (AC 3)', async () => {
    const stdout = '{"type":"turn.completed","usage":{"input_tokens":"many","output_tokens":5}}';
    const rec = recordingExec({ stdout }, async (cmd) => {
      await realWriteFile(outFileFromCmd(cmd), 'CODEX OUTPUT');
    });
    const harness = new CodexCliHarness(rec.fn);

    const result = await harness.run(makeContractRequest({ model: 'codex-model', registry, prompt: 'build it' }));

    expect(result.usage).toBeUndefined();
  });

  it('tolerates non-JSON noise interleaved with the usage line', async () => {
    const stdout = [
      'warning: running inside sandbox wrapper',
      '{"type":"turn.completed","usage":{"input_tokens":15785,"cached_input_tokens":9984,"output_tokens":5}}',
      'not json at all {{{',
    ].join('\n');
    const rec = recordingExec({ stdout }, async (cmd) => {
      await realWriteFile(outFileFromCmd(cmd), 'CODEX OUTPUT');
    });
    const harness = new CodexCliHarness(rec.fn);

    const result = await harness.run(makeContractRequest({ model: 'codex-model', registry, prompt: 'build it' }));

    expect(result.usage).toEqual({
      inputTokens: 15785,
      outputTokens: 5,
      rawInputTokens: 5801,
      cacheReadTokens: 9984,
    });
  });

  it('treats absent cached_input_tokens as zero', async () => {
    const stdout = '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}';
    const rec = recordingExec({ stdout }, async (cmd) => {
      await realWriteFile(outFileFromCmd(cmd), 'CODEX OUTPUT');
    });
    const harness = new CodexCliHarness(rec.fn);

    const result = await harness.run(makeContractRequest({ model: 'codex-model', registry, prompt: 'build it' }));

    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      rawInputTokens: 100,
      cacheReadTokens: 0,
    });
  });

  it('clamps rawInputTokens to zero when cached_input_tokens exceeds input_tokens', async () => {
    const stdout = '{"type":"turn.completed","usage":{"input_tokens":50,"cached_input_tokens":80,"output_tokens":10}}';
    const rec = recordingExec({ stdout }, async (cmd) => {
      await realWriteFile(outFileFromCmd(cmd), 'CODEX OUTPUT');
    });
    const harness = new CodexCliHarness(rec.fn);

    const result = await harness.run(makeContractRequest({ model: 'codex-model', registry, prompt: 'build it' }));

    expect(result.usage).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      rawInputTokens: 0,
      cacheReadTokens: 80,
    });
  });

  it('resolves with no usage on empty stdout', async () => {
    const rec = successExec();
    const harness = new CodexCliHarness(rec.fn);

    const result = await harness.run(makeContractRequest({ model: 'codex-model', registry, prompt: 'build it' }));

    expect(result.usage).toBeUndefined();
  });
});

describe('CodexCliHarness temp file cleanup', () => {
  it('removes both temp files after a successful run', async () => {
    const rec = successExec();
    const harness = new CodexCliHarness(rec.fn);

    await harness.run(makeContractRequest({ model: 'codex-model', registry, prompt: 'build it' }));

    expectTempFilesCleanedUp(rec.calls[0].cmd);
  });

  it('removes both temp files after a failing run', async () => {
    const rec = recordingExec();
    const harness = new CodexCliHarness(async (cmd, opts) => {
      rec.calls.push({ cmd, opts });
      throw Object.assign(new Error('boom'), { stderr: 'boom', code: 1 });
    });

    const err: any = await harness
      .run(makeContractRequest({ model: 'codex-model', registry, prompt: 'build it' }))
      .catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expectTempFilesCleanedUp(rec.calls[0].cmd);
  });

  it('removes both temp files after an empty-output run', async () => {
    const rec = recordingExec();
    const harness = new CodexCliHarness(rec.fn);

    const err: any = await harness
      .run(makeContractRequest({ model: 'codex-model', registry, prompt: 'build it' }))
      .catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('empty_response');
    expect(err.details.exitCode).toBe(0);
    expectTempFilesCleanedUp(rec.calls[0].cmd);
  });
});
