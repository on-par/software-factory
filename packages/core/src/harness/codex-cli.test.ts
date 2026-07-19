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
    expect(cmd).toMatch(/^codex exec --sandbox workspace-write -c approval_policy=never -C '/);
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
    expect(rec.calls[0].cmd).toMatch(/^codex exec --sandbox workspace-write -c approval_policy=never -C '/);
    expect(rec.calls[0].cmd).not.toContain('--model');
  });

  it('wraps the invocation in sandbox-exec when request.sandbox is set', async () => {
    const rec = recordingExec();
    const harness = new CodexCliHarness(rec.fn);

    await harness
      .run(makeContractRequest({ model: 'codex-model', registry, prompt: 'build it', sandbox: sandboxPolicy }))
      .catch(() => {});

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].cmd.startsWith('sandbox-exec -p ')).toBe(true);
    expect(rec.calls[0].cmd).toContain('codex exec --sandbox workspace-write');
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
});
