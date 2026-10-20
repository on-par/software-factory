import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile as realWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import type { RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { ModelRegistry } from '../models/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { CodexCliHarness, quoteCodexFlags } from './codex-cli.js';
import { codingHarnessContractCases, makeContractRequest } from './contract.js';
import { HarnessError } from './index.js';

const sandboxPolicy: SandboxPolicy = {
  runtime: 'sandbox-exec',
  worktree: '/tmp/factory worktree',
  writablePaths: ['/tmp/factory worktree'],
  writableFilePrefixes: [],
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
    expect(cmd).toContain('approval_policy=never -c sandbox_workspace_write.network_access=false -C');
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
    expect(rec.calls[0].cmd).toContain('network_access=false -C');
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

  it('uses the outer wrapper when present and Codex workspace-write for runtime none', async () => {
    const rec = recordingExec();
    const harness = new CodexCliHarness(rec.fn);
    await harness
      .run(makeContractRequest({ model: 'codex-model', registry, prompt: 'build it', sandbox: sandboxPolicy }))
      .catch(() => {});
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].cmd.startsWith('sandbox-exec -p ')).toBe(true);
    expect(rec.calls[0].cmd).toContain('codex exec --json --sandbox workspace-write');
    const none = { ...sandboxPolicy, runtime: 'none' as const, allowHosts: ['example.com'] };
    const request = makeContractRequest({ model: 'codex-model', registry, task: 'plan', sandbox: none });
    await harness.run(request).catch(() => {});
    expect(rec.calls[1].cmd).toMatch(/^codex exec --json --sandbox workspace-write /);
    expect(rec.calls[1].cmd).toContain('-c sandbox_workspace_write.network_access=true');
    expect(rec.calls[1].cmd).toContain('-c features.network_proxy.enabled=true');
    expect(rec.calls[1].cmd).toContain('"example.com"="allow"');
    expect(rec.calls[1].cmd).toContain('"api.github.com"="allow"');
  });
});

it('codex cost row carries the model-call count and peak context from the session rollout', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'factory-codex-rollout-'));
  try {
    const threadId = '019ff914-ffab-7d32-9e8d-2b202a31c34f';
    const sessionDir = join(codexHome, 'sessions', '2026', '10', '19');
    await mkdir(sessionDir, { recursive: true });
    await realWriteFile(
      join(sessionDir, `rollout-2026-10-19T00-00-00-${threadId}.jsonl`),
      [27779, 120001, 198303]
        .map((input, index) =>
          JSON.stringify({
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: {
                last_token_usage: { input_tokens: input, output_tokens: 10, total_tokens: input + 10 },
                total_token_usage: { input_tokens: input, output_tokens: 10, total_tokens: (index + 1) * 200000 },
                model_context_window: 272000,
              },
            },
          }),
        )
        .join('\n'),
    );
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: threadId }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 15785, cached_input_tokens: 9984, output_tokens: 5 },
      }),
    ].join('\n');
    const rec = recordingExec({ stdout }, async (cmd) => realWriteFile(outFileFromCmd(cmd), 'CODEX OUTPUT'));
    const harness = new CodexCliHarness(rec.fn);
    const result = await harness.run(
      makeContractRequest({ model: 'codex-model', registry, prompt: 'build it', env: { CODEX_HOME: codexHome } }),
    );
    expect(result.usage).toMatchObject({
      inputTokens: 15785,
      outputTokens: 5,
      rawInputTokens: 5801,
      cacheReadTokens: 9984,
      numTurns: 3,
      peakInputTokens: 198303,
      contextWindow: 272000,
    });

    const costModels: ModelsConfig = {
      ...modelsConfig,
      models: { 'codex-model': { ...modelsConfig.models['codex-model'], costPerMtokInput: 3, costPerMtokOutput: 15 } },
    };
    const routes: RoutesConfig = { version: 1, routes: { build_codex: { tier: 'boss', description: 'test' } } };
    const router = new ModelRouter(costModels, routes, false, {
      runModel: async (_model, _prompt, context) => {
        if (result.usage) context.onUsage?.(result.usage);
        return result.output;
      },
    });
    const rows: { cost: number | null; costPerCallUsd?: number }[] = [];
    router.setCostSink((entry) => rows.push(entry));
    await router.run('build_codex', 'build it');
    expect(rows).toHaveLength(1);
    const rowCost = rows[0].cost;
    if (rowCost === null) throw new Error('expected a priced cost row');
    expect(rows[0].costPerCallUsd).toBe(rowCost / 3);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
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
  it('turns a logged-out 401 into local_auth with a one-line codex login hint (#2494)', async () => {
    const stdout = [
      '{"type":"thread.started"}',
      '{"type":"error","message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses"}',
      '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer"}}',
    ].join('\n');
    const harness = new CodexCliHarness(async () => {
      throw Object.assign(new Error(`Command failed: codex exec\n${stdout}`), { stdout, stderr: '', code: 1 });
    });

    const err: any = await harness.run(makeContractRequest({ model: 'codex-model', registry })).catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('local_auth');
    expect(err.message).toBe('codex is not signed in (401): run `codex login`, then retry');
    expect(err.message).not.toContain('{');
    expect(err.details.stdout).toBeUndefined();
    expect(err.details.stderr).toBeUndefined();
  });

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

describe('quoteCodexFlags (CodeQL #107)', () => {
  /** What argv the shell would actually hand to codex for the rendered flags. */
  function argvThroughShell(rendered: string, cwd: string): string[] {
    const out = execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${rendered}`], { cwd, encoding: 'utf-8' });
    return out.split('\0').slice(0, -1);
  }

  it('leaves plain flags byte-identical', () => {
    expect(quoteCodexFlags('-m gpt-5.6-sol -c model_reasoning_effort=medium')).toBe(
      '-m gpt-5.6-sol -c model_reasoning_effort=medium',
    );
    expect(quoteCodexFlags('--oss --local-provider ollama -m qwen2.5-coder:14b')).toBe(
      '--oss --local-provider ollama -m qwen2.5-coder:14b',
    );
    expect(quoteCodexFlags('')).toBe('');
  });

  it('keeps multiple -c key=value flags and shell-quoted values working', () => {
    const flags = `-m gpt-6-astra -c 'developer_instructions="keep -c x=1 literal"' -c "a=b c" -c k=v`;
    expect(quoteCodexFlags(flags)).toBe(flags.replace(`"a=b c"`, `'a=b c'`));
  });

  it.skipIf(process.platform === 'win32')(
    'turns hostile shell syntax into literal codex arguments instead of running it',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'codex-flag-'));
      try {
        const hostile = 'x; touch pwned1 && touch pwned2 | touch pwned3 $(touch pwned4) `touch pwned5` > pwned6';
        const argv = argvThroughShell(quoteCodexFlags(hostile), dir);
        expect(argv).toEqual([
          'x;',
          'touch',
          'pwned1',
          '&&',
          'touch',
          'pwned2',
          '|',
          'touch',
          'pwned3',
          '$(touch',
          'pwned4)',
          '`touch',
          'pwned5`',
          '>',
          'pwned6',
        ]);
        for (let i = 1; i <= 6; i++) expect(existsSync(join(dir, `pwned${i}`))).toBe(false);

        const quoted = `-c "x=$(touch pwned7)" -c 'y=\`touch pwned8\`' -c it\\'s`;
        expect(argvThroughShell(quoteCodexFlags(quoted), dir)).toEqual([
          '-c',
          'x=$(touch pwned7)',
          '-c',
          'y=`touch pwned8`',
          '-c',
          "it's",
        ]);
        expect(existsSync(join(dir, 'pwned7'))).toBe(false);
        expect(existsSync(join(dir, 'pwned8'))).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('rejects an unterminated quote', () => {
    expect(() => quoteCodexFlags(`-c 'oops`)).toThrow(/unterminated/);
  });

  it('never splices a hostile codexFlag raw into the codex command', async () => {
    const hostileRegistry = new ModelRegistry({
      ...modelsConfig,
      models: {
        ...modelsConfig.models,
        'codex-model': { ...modelsConfig.models['codex-model'], codexFlag: 'x; touch /tmp/pwned' },
      },
    });
    const rec = successExec();
    await new CodexCliHarness(rec.fn).run(
      makeContractRequest({ model: 'codex-model', registry: hostileRegistry, prompt: 'p', worktree: '/tmp/w' }),
    );
    expect(rec.calls[0].cmd).toContain(`-C '/tmp/w' 'x;' touch /tmp/pwned -o '`);
  });
});
