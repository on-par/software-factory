import { existsSync } from 'node:fs';
import { writeFile as realWriteFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { CodexCliHarness } from './codex-cli.js';
import { codingHarnessContractCases, makeContractRequest } from './contract.js';
import { HarnessError } from './index.js';

const sandboxPolicy: SandboxPolicy = {
  runtime: 'sandbox-exec',
  worktree: '/tmp/factory worktree',
  writablePaths: ['/tmp/factory worktree'],
  allowHosts: [],
  cpuMs: 300_000,
  memMb: 4096,
};

function outFileFromCmd(cmd: string): string {
  const match = cmd.match(/-o '([^']+)'/);
  if (!match) throw new Error(`could not find outFile in cmd: ${cmd}`);
  return match[1];
}

function tempPathsFromCmd(cmd: string): { outFile: string; tmpFile: string } {
  return {
    outFile: cmd.match(/ -o '([^']+)'/)![1],
    tmpFile: cmd.match(/ < '([^']+)'$/)![1],
  };
}

function expectTempFilesCleanedUp(cmd: string): void {
  const { outFile, tmpFile } = tempPathsFromCmd(cmd);
  expect(existsSync(outFile)).toBe(false);
  expect(existsSync(tmpFile)).toBe(false);
}

describe('CodingHarness contract: CodexCliHarness', () => {
  const cases = codingHarnessContractCases({
    success: () => ({
      harness: new CodexCliHarness(async (cmd) => {
        await realWriteFile(outFileFromCmd(cmd), 'codex output');
        return { stdout: '', stderr: '' };
      }),
    }),
    timeout: () => ({
      harness: new CodexCliHarness(async () => {
        throw Object.assign(new Error('killed'), { killed: true });
      }),
    }),
    emptyOutput: () => ({ harness: new CodexCliHarness(async () => ({ stdout: '', stderr: '' })) }),
    failure: () => ({
      harness: new CodexCliHarness(async () => {
        throw Object.assign(new Error('boom'), { stderr: 'rate limit exceeded', code: 1 });
      }),
    }),
  });
  for (const contractCase of cases) it(contractCase.name, contractCase.run);
});

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
    'codex-no-flag': {
      provider: 'openai',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      codex: true,
    },
  },
  tiers: { boss: ['codex-model', 'codex-no-flag'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const registry = new ModelRegistry(modelsConfig);

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
  return recordingExec({}, async (cmd) => {
    await realWriteFile(outFileFromCmd(cmd), 'CODEX OUTPUT');
  });
}

describe('CodexCliHarness command shape', () => {
  it('builds the expected invocation with a codex flag', async () => {
    const rec = successExec();
    const harness = new CodexCliHarness(rec.fn);

    const result = await harness.run(
      makeContractRequest({
        model: 'codex-model',
        registry,
        prompt: 'build it',
        worktree: '/tmp/factory worktree',
        timeoutSeconds: 7,
      }),
    );

    expect(result.output).toBe('CODEX OUTPUT');
    expect(rec.calls).toHaveLength(1);
    const { cmd, opts } = rec.calls[0];
    expect(cmd).toMatch(/^codex exec --json --sandbox workspace-write -c approval_policy=never -C '/);
    expect(cmd).toContain("-C '/tmp/factory worktree'");
    expect(cmd).toContain('--model gpt-5-codex');
    expect(cmd).toMatch(/ -o '\/.*factory-codex-out-[^']+' - </);
    expect(cmd).toMatch(/ - < '\/.*factory-codex-[^']+'$/);
    expect(opts.timeoutMs).toBe(7 * 1000);
    expect(opts.maxBuffer).toBe(10 * 1024 * 1024);
    expect(opts.cwd).toBeUndefined();
  });

  it('omits the model flag when none is configured, still parses', async () => {
    const rec = successExec();
    const harness = new CodexCliHarness(rec.fn);

    await harness.run(makeContractRequest({ model: 'codex-no-flag', registry, prompt: 'build it' }));

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].cmd).toMatch(/^codex exec --json --sandbox workspace-write -c approval_policy=never -C '/);
    expect(rec.calls[0].cmd).not.toContain('--model');
  });

  it('forwards request.env verbatim to the execFn opts', async () => {
    const rec = successExec();
    const harness = new CodexCliHarness(rec.fn);

    await harness.run(
      makeContractRequest({
        model: 'codex-model',
        registry,
        prompt: 'build it',
        env: { PORT: '3142', FACTORY_APP_PORT: '3142', FACTORY_BASE_URL: 'http://127.0.0.1:3142' },
      }),
    );

    expect(rec.calls[0].opts.env).toEqual({
      PORT: '3142',
      FACTORY_APP_PORT: '3142',
      FACTORY_BASE_URL: 'http://127.0.0.1:3142',
    });
  });

  it('forwards request.onPgid to the execFn opts', async () => {
    const rec = successExec();
    const harness = new CodexCliHarness(rec.fn);
    const onPgid = () => {};

    await harness.run(makeContractRequest({ model: 'codex-model', registry, prompt: 'build it', onPgid }));

    expect(rec.calls[0].opts.onPgid).toBe(onPgid);
  });

  it('leaves opts.env undefined when the request has no env', async () => {
    const rec = successExec();
    const harness = new CodexCliHarness(rec.fn);

    await harness.run(makeContractRequest({ model: 'codex-model', registry, prompt: 'build it' }));

    expect(rec.calls[0].opts.env).toBeUndefined();
  });

  it('wraps the invocation in sandbox-exec when request.sandbox is set', async () => {
    const rec = recordingExec();
    const harness = new CodexCliHarness(rec.fn);

    await harness
      .run(makeContractRequest({ model: 'codex-model', registry, prompt: 'build it', sandbox: sandboxPolicy }))
      .catch(() => {});

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].cmd.startsWith('sandbox-exec -p ')).toBe(true);
    expect(rec.calls[0].cmd).toContain('codex exec --json --sandbox workspace-write');
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

    const result = await harness.run(makeContractRequest({ model: 'codex-model', registry, prompt: 'build it' }));

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

describe('CodexCliHarness served-model verification', () => {
  it('throws when the codex CLI banner reports a different model than requested (#415)', async () => {
    const rec = recordingExec({ stderr: 'model: gpt-5.6-sol\nreasoning effort: high' }, async (cmd) => {
      await realWriteFile(outFileFromCmd(cmd), 'CODEX OUTPUT');
    });
    const harness = new CodexCliHarness(rec.fn);

    const err: any = await harness
      .run(makeContractRequest({ model: 'codex-model', registry, prompt: 'build it' }))
      .catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('error');
    expect(err.message).toContain('gpt-5.6-sol');
    expect(err.message).toContain('gpt-5-codex');
    expect(err.details.stderr).toBe('model: gpt-5.6-sol\nreasoning effort: high');
    expectTempFilesCleanedUp(rec.calls[0].cmd);
  });

  it('succeeds when the codex CLI banner matches the requested model', async () => {
    const rec = recordingExec({ stderr: 'model: gpt-5-codex\nreasoning effort: high' }, async (cmd) => {
      await realWriteFile(outFileFromCmd(cmd), 'CODEX OUTPUT');
    });
    const harness = new CodexCliHarness(rec.fn);

    const result = await harness.run(makeContractRequest({ model: 'codex-model', registry, prompt: 'build it' }));

    expect(result.output).toBe('CODEX OUTPUT');
  });

  it('tolerates a missing model banner (older/quieter CLI, sandbox wrappers)', async () => {
    const rec = successExec();
    const harness = new CodexCliHarness(rec.fn);

    const result = await harness.run(makeContractRequest({ model: 'codex-model', registry, prompt: 'build it' }));

    expect(result.output).toBe('CODEX OUTPUT');
  });

  it('skips verification when no model is pinned, even with a foreign banner', async () => {
    const rec = recordingExec({ stderr: 'model: gpt-5.6-sol' }, async (cmd) => {
      await realWriteFile(outFileFromCmd(cmd), 'CODEX OUTPUT');
    });
    const harness = new CodexCliHarness(rec.fn);

    const result = await harness.run(makeContractRequest({ model: 'codex-no-flag', registry, prompt: 'build it' }));

    expect(result.output).toBe('CODEX OUTPUT');
  });
});

describe('CodexCliHarness failure classification', () => {
  it('classifies usage_cap from stderr', async () => {
    const harness = new CodexCliHarness(async () => {
      throw Object.assign(new Error('boom'), { stderr: 'quota exceeded', code: 1 });
    });

    const err: any = await harness.run(makeContractRequest({ model: 'codex-model', registry })).catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('usage_cap');
    expect(err.details.stderr).toBe('quota exceeded');
  });

  it('classifies killed exec as timeout', async () => {
    const harness = new CodexCliHarness(async () => {
      throw Object.assign(new Error('killed'), { killed: true });
    });

    const err: any = await harness.run(makeContractRequest({ model: 'codex-model', registry })).catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('timeout');
  });

  it('classifies from the JSONL error stream when stderr is empty', async () => {
    const stdout = '{"type":"turn.failed","error":{"message":"stream error: rate limit exceeded"}}';
    const harness = new CodexCliHarness(async () => {
      throw Object.assign(new Error('boom'), { stderr: '', code: 1, stdout });
    });

    const err: any = await harness.run(makeContractRequest({ model: 'codex-model', registry })).catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('rate_limit');
    expect(err.details.stdout).toContain('stream error: rate limit exceeded');
  });

  it('does not misclassify agent prose mentioning limit-like words', async () => {
    const stdout =
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"we should check the quota and rate limit code"}}';
    const harness = new CodexCliHarness(async () => {
      throw Object.assign(new Error('boom'), { stderr: '', code: 1, stdout });
    });

    const err: any = await harness.run(makeContractRequest({ model: 'codex-model', registry })).catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('unknown');
  });
});
