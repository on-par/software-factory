import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import { type SandboxPolicy, wrapCommandInSandbox } from '../sandbox/index.js';
import { codingHarnessContractCases, makeContractRequest } from './contract.js';
import { HarnessError } from './index.js';
import { buildPiCommand, PiHarness, parsePiJson } from './pi.js';

const fixture = (name: string) =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', 'pi', name), 'utf8');

const sandboxPolicy: SandboxPolicy = {
  runtime: 'sandbox-exec',
  worktree: '/tmp/factory worktree',
  writablePaths: ['/tmp/factory worktree'],
  writableFilePrefixes: [],
  allowHosts: [],
  cpuMs: 300_000,
  memMb: 4096,
};

const modelBase: ModelsConfig['models'][string] = {
  provider: 'custom',
  tier: 'boss',
  costPerMtokInput: 0,
  costPerMtokOutput: 0,
  contextWindow: 1000,
  capabilities: [],
  envKey: null,
  harness: 'pi',
};

const modelsConfig: ModelsConfig = {
  version: 1,
  models: {
    'pi-model': { ...modelBase, providerModel: 'openrouter/deepseek/deepseek-v4-flash' },
    'pi-no-provider-model': { ...modelBase },
    'pi-no-slash': { ...modelBase, providerModel: 'deepseek' },
  },
  tiers: { boss: ['pi-model', 'pi-no-provider-model', 'pi-no-slash'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};
const registry = new ModelRegistry(modelsConfig);

const success = fixture('success.jsonl');
const req = (overrides = {}) => makeContractRequest({ model: 'pi-model', registry, ...overrides });
const okExec = (stdout = success) => vi.fn(async (_cmd: string, _opts: any) => ({ stdout, stderr: '' }));

describe('CodingHarness contract: PiHarness', () => {
  const cases = codingHarnessContractCases({
    success: () => ({ harness: new PiHarness(okExec()), request: { model: 'pi-model', registry } }),
    timeout: () => ({
      harness: new PiHarness(async () => {
        throw Object.assign(new Error('killed'), { killed: true });
      }),
      request: { model: 'pi-model', registry },
    }),
    emptyOutput: () => ({
      harness: new PiHarness(async () => ({ stdout: '   ', stderr: '' })),
      request: { model: 'pi-model', registry },
    }),
    failure: () => ({
      harness: new PiHarness(async () => {
        throw Object.assign(new Error('boom'), { stderr: 'rate limit exceeded', code: 1 });
      }),
      request: { model: 'pi-model', registry },
    }),
  });
  for (const contractCase of cases) it(contractCase.name, contractCase.run);
});

describe('parsePiJson', () => {
  it('returns the last assistant message_end text and summed usage with costUsd', () => {
    const parsed = parsePiJson(success)!;
    expect(parsed.text).toBe('Final answer');
    expect(parsed.lastStopReason).toBe('stop');
    expect(parsed.aborted).toBe(false);
    expect(parsed.usage).toMatchObject({
      inputTokens: 360,
      outputTokens: 60,
      rawInputTokens: 300,
      cacheReadTokens: 50,
      cacheCreationTokens: 10,
      numTurns: 2,
    });
    expect(parsed.usage?.costUsd).toBeCloseTo(0.0042, 6);
  });

  it('splits on LF only and keeps U+2028 intact', () => {
    const parsed = parsePiJson(fixture('u2028.jsonl'))!;
    expect(parsed.text).toContain(' ');
    expect(parsed.text).toBe('alpha beta');
    expect(parsed.aborted).toBe(false);
    expect(parsed.lastStopReason).toBe('stop');
  });

  it('returns undefined without events and tolerates junk lines', () => {
    expect(parsePiJson('')).toBeUndefined();
    expect(parsePiJson('not json\n[1]\n{"a":1}\n42\n')).toBeUndefined();
    const parsed = parsePiJson(
      'junk\n{"type":"message_end","message":{"role":"assistant","stopReason":5,"usage":{"input":1,"output":2,"cost":{"total":"x"}}}}\n{"type":"agent_settled","aborted":"no"}',
    )!;
    expect(parsed.text).toBe('');
    expect(parsed.lastStopReason).toBeUndefined();
    expect(parsed.aborted).toBeUndefined();
    expect(parsed.usage?.costUsd).toBeUndefined();
  });

  it('omits usage when no assistant message reports tokens', () => {
    expect(parsePiJson('{"type":"agent_start"}')?.usage).toBeUndefined();
  });
});

describe('buildPiCommand', () => {
  it('rejects missing, prefix-less and trailing-slash provider models', () => {
    for (const bad of [undefined, '', 'deepseek', '/model', 'openrouter/']) {
      expect(() => buildPiCommand(bad, '/tmp/p')).toThrow(HarnessError);
    }
  });
});

describe('PiHarness', () => {
  it('passes the required headless flags and splits providerModel into --provider/--model', async () => {
    const exec = okExec();
    const result = await new PiHarness(exec).run(req({ worktree: '/tmp/factory worktree', timeoutSeconds: 7 }));
    expect(result.output).toBe('Final answer');
    expect(result.usage?.costUsd).toBeCloseTo(0.0042, 6);
    const [cmd, opts] = exec.mock.calls[0];
    expect(cmd).toContain('pi -p --mode json --no-session --no-context-files --no-extensions --no-skills');
    expect(cmd).toContain('--no-prompt-templates --no-mcp --no-approve --offline');
    expect(cmd).toContain("--provider 'openrouter' --model 'deepseek/deepseek-v4-flash'");
    expect(cmd).toMatch(/ < '[^']*factory-pi-prompt-[^']*\/prompt\.txt'$/);
    expect(opts.cwd).toBe('/tmp/factory worktree');
    expect(opts.timeoutMs).toBe(7000);
    expect(opts.maxBuffer).toBe(64 * 1024 * 1024);
  });

  it('drops DEEPSEEK_API_KEY from the child env', async () => {
    const exec = okExec();
    await new PiHarness(exec).run(req({ env: { DEEPSEEK_API_KEY: 'd', OPENROUTER_API_KEY: 'o' } }));
    const env = exec.mock.calls[0][1].env;
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBe('o');
  });

  it('still blanks a parent-env DEEPSEEK_API_KEY when request.env is undefined', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'secret');
    try {
      const exec = okExec();
      await new PiHarness(exec).run(req());
      // Present-but-undefined so the ExecFn's merge over process.env removes the parent's copy.
      expect(exec.mock.calls[0][1].env).toHaveProperty('DEEPSEEK_API_KEY', undefined);
      expect(process.env.DEEPSEEK_API_KEY).toBe('secret');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects with HarnessError when the last assistant stopReason is error despite exit 0', async () => {
    const err = await new PiHarness(okExec(fixture('stop-error.jsonl'))).run(req()).catch((e) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('error');
    expect(err.message).toContain('stopReason error');
    expect(err.message).toContain('provider error');
  });

  it('rejects when agent_settled is missing or aborted is true', async () => {
    const lines = success.trim().split('\n');
    const missing = lines.slice(0, -1).join('\n');
    const aborted = [...lines.slice(0, -1), '{"type":"agent_settled","aborted":true}'].join('\n');
    for (const stdout of [missing, aborted]) {
      const err = await new PiHarness(okExec(stdout)).run(req()).catch((e) => e);
      expect(err).toBeInstanceOf(HarnessError);
      expect(err.reason).toBe('error');
    }
  });

  it('rejects with empty_response when the final text is empty', async () => {
    const stdout =
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"  "}],"stopReason":"stop"}}\n{"type":"agent_settled","aborted":false}\n';
    const err = await new PiHarness(okExec(stdout)).run(req()).catch((e) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('empty_response');
  });

  it('rejects output with no JSON events', async () => {
    const blank = await new PiHarness(okExec('  ')).run(req()).catch((e) => e);
    expect(blank.reason).toBe('empty_response');
    const text = await new PiHarness(okExec('plain text')).run(req()).catch((e) => e);
    expect(text.reason).toBe('error');
  });

  it('rejects a providerModel without a provider prefix and does not run pi', async () => {
    for (const model of ['pi-no-provider-model', 'pi-no-slash']) {
      const exec = okExec();
      const err = await new PiHarness(exec).run(req({ model })).catch((e) => e);
      expect(err).toBeInstanceOf(HarnessError);
      expect(err.reason).toBe('error');
      expect(exec).not.toHaveBeenCalled();
    }
  });

  it('wraps the command with wrapCommandInSandbox when request.sandbox is set', async () => {
    const exec = okExec();
    await new PiHarness(exec).run(req({ sandbox: sandboxPolicy }));
    const cmd: string = exec.mock.calls[0][0];
    // The prompt path is a fresh temp file; recover it from the executed command.
    const promptPath = /([^'\s]*factory-pi-prompt-[^'\s]*\/prompt\.txt)/.exec(cmd)?.[1];
    expect(promptPath).toBeDefined();
    expect(cmd).toBe(
      wrapCommandInSandbox(buildPiCommand('openrouter/deepseek/deepseek-v4-flash', promptPath!), sandboxPolicy),
    );
  });

  it('maps a non-zero exit/killed exec rejection to a classified HarnessError (timeout when killed)', async () => {
    const killed = new PiHarness(async () => {
      throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' });
    });
    const k = await killed.run(req()).catch((e) => e);
    expect(k.reason).toBe('timeout');

    const failed = new PiHarness(async () => {
      throw Object.assign(new Error('boom'), {
        code: 1,
        stderr: 'x',
        stdout: '{"type":"message_end","message":{"role":"assistant","errorMessage":"rate limit exceeded"}}',
      });
    });
    const f = await failed.run(req()).catch((e) => e);
    expect(f).toBeInstanceOf(HarnessError);
    expect(f.reason).toBe('rate_limit');
  });
});
