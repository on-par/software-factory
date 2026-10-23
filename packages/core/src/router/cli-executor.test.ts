import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile as realWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { LEGACY_CODEX_OLLAMA_HARNESS } from '../harness/catalog.js';
import { HarnessError, KNOWN_HARNESS_IDS } from '../harness/index.js';
import { StubCodingHarness } from '../harness/stub.js';
import { ModelRegistry } from '../models/index.js';
import { CliModelExecutor, ModelRouter } from './index.js';
import { resetOllamaProbeCache } from './ollama-probe.js';

const modelsConfig: ModelsConfig = {
  version: 1,
  models: {
    'claude-model': {
      provider: 'anthropic',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      claudeFlag: 'claude-sonnet-5',
    },
    'claude-no-flag': {
      provider: 'anthropic',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
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
    'ollama-model': {
      provider: 'ollama',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 32768,
      capabilities: [],
      envKey: null,
      providerModel: 'qwen2.5-coder:14b',
      providerOptions: { num_ctx: 16384, temperature: 0.2 },
    },
    'ollama-codex-model': {
      provider: 'ollama',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 32768,
      capabilities: [],
      envKey: null,
      providerModel: 'qwen2.5-coder:14b',
      codex: true,
      codexFlag: '--oss --local-provider ollama -m qwen2.5-coder:14b',
    },
    'ollama-declared-claude-cli': {
      provider: 'ollama',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'claude-cli',
      claudeFlag: 'claude-sonnet-5',
    },
    'opencode-declared': {
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
    'ollama-agentic-declared': {
      provider: 'ollama',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 32768,
      capabilities: [],
      envKey: null,
      harness: 'ollama-agentic',
      providerModel: 'qwen3.5:9b',
      providerOptions: { num_ctx: 8192 },
    },
  },
  tiers: {
    boss: [
      'claude-model',
      'claude-no-flag',
      'codex-model',
      'ollama-model',
      'ollama-codex-model',
      'ollama-declared-claude-cli',
      'opencode-declared',
      'ollama-agentic-declared',
    ],
  },
  failover: {
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
  },
  routingRules: {},
};

const routesConfig: RoutesConfig = {
  version: 1,
  routes: {
    plan: { tier: 'boss', description: 'stub' },
    build_codex: { tier: 'boss', description: 'stub', requires: 'codex' },
  },
};

const registry = new ModelRegistry(modelsConfig);
const worktree = '/tmp/factory worktree';
const timeoutSeconds = 7;
let tmpWorktree: string | undefined;

afterEach(async () => {
  if (tmpWorktree) {
    await rm(tmpWorktree, { recursive: true, force: true });
    tmpWorktree = undefined;
  }
});

function recordingExec(
  result: { stdout?: string; stderr?: string } = {},
  onCmd?: (cmd: string) => Promise<void> | void,
) {
  const calls: { cmd: string; opts: any }[] = [];
  const fn = async (cmd: string, opts: any) => {
    if (cmd !== 'opencode --version') calls.push({ cmd, opts });
    if (onCmd) await onCmd(cmd);
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { fn, calls };
}

function outFileFromCmd(cmd: string): string {
  const match = cmd.match(/-o '([^']+)'/);
  if (!match) throw new Error(`could not find outFile in cmd: ${cmd}`);
  return match[1];
}

describe('CliModelExecutor', () => {
  it('runs Claude with the expected invocation shape', async () => {
    const rec = recordingExec({ stdout: 'CLAUDE OUTPUT' });
    const executor = new CliModelExecutor(rec.fn);

    const output = await executor.runModel('claude-model', 'draft plan', {
      worktree,
      timeoutSeconds,
      task: 'plan',
      registry,
      routesConfig,
    });

    expect(output).toBe('CLAUDE OUTPUT');
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].cmd).toContain('claude -p');
    expect(rec.calls[0].cmd).toContain("--model 'claude-sonnet-5'");
    expect(rec.calls[0].cmd).toContain('--output-format stream-json');
    expect(rec.calls[0].cmd).toContain('--permission-mode bypassPermissions');
    expect(rec.calls[0].cmd).toMatch(/< '?[^']*factory-claude-prompt-[^']+\/prompt\.txt'?$/);
    expect(rec.calls[0].opts.cwd).toBe(worktree);
    expect(rec.calls[0].opts.timeoutMs).toBe(timeoutSeconds * 1000);
  });

  it('reports parsed HarnessUsage to ctx.onUsage when the claude CLI returns a JSON envelope', async () => {
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'CLAUDE OUTPUT',
      total_cost_usd: 0.0123,
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: 4500,
        cache_read_input_tokens: 230000,
        output_tokens: 890,
      },
    });
    const rec = recordingExec({ stdout: envelope });
    const executor = new CliModelExecutor(rec.fn);
    const usages: unknown[] = [];

    const output = await executor.runModel('claude-model', 'draft plan', {
      worktree,
      timeoutSeconds,
      task: 'plan',
      registry,
      routesConfig,
      onUsage: (u) => usages.push(u),
    });

    expect(output).toBe('CLAUDE OUTPUT');
    expect(usages).toEqual([
      {
        inputTokens: 12 + 4500 + 230000,
        outputTokens: 890,
        rawInputTokens: 12,
        cacheReadTokens: 230000,
        cacheCreationTokens: 4500,
        costUsd: 0.0123,
      },
    ]);
  });

  it('runs Claude without a model flag when none is configured', async () => {
    const rec = recordingExec({ stdout: 'CLAUDE OUTPUT' });
    const executor = new CliModelExecutor(rec.fn);

    await executor.runModel('claude-no-flag', 'draft plan', {
      worktree,
      timeoutSeconds,
      task: 'plan',
      registry,
      routesConfig,
    });

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].cmd).toContain('claude -p');
    expect(rec.calls[0].cmd).not.toMatch(/(^|\s)--model(\s|$)/);
    expect(rec.calls[0].cmd).toContain('--permission-mode bypassPermissions');
  });

  it('forwards ctx.env through to the harness request env', async () => {
    const rec = recordingExec({ stdout: 'CLAUDE OUTPUT' });
    const executor = new CliModelExecutor(rec.fn);

    await executor.runModel('claude-model', 'draft plan', {
      worktree,
      timeoutSeconds,
      task: 'plan',
      registry,
      routesConfig,
      env: { PORT: '3142', FACTORY_APP_PORT: '3142', FACTORY_BASE_URL: 'http://127.0.0.1:3142' },
    });

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].opts.env).toEqual({
      PORT: '3142',
      FACTORY_APP_PORT: '3142',
      FACTORY_BASE_URL: 'http://127.0.0.1:3142',
    });
  });

  it('forwards ctx.onPgid through to the harness request', async () => {
    const rec = recordingExec({ stdout: 'CLAUDE OUTPUT' });
    const executor = new CliModelExecutor(rec.fn);
    const onPgid = () => {};

    await executor.runModel('claude-model', 'draft plan', {
      worktree,
      timeoutSeconds,
      task: 'plan',
      registry,
      routesConfig,
      onPgid,
    });

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].opts.onPgid).toBe(onPgid);
  });

  it('runs Codex with flags, output file, and prompt-file stdin redirect', async () => {
    const rec = recordingExec();
    const executor = new CliModelExecutor(rec.fn);

    const err: any = await executor
      .runModel('codex-model', 'build it', {
        worktree,
        timeoutSeconds,
        task: 'build_codex',
        registry,
        routesConfig,
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('empty_response');
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].cmd).toContain('network_access=false -C ');
    expect(rec.calls[0].cmd).toContain(`-C '${worktree}'`);
    expect(rec.calls[0].cmd).toContain('--model gpt-5-codex');
    expect(rec.calls[0].cmd).toContain(' -o ');
    expect(rec.calls[0].cmd).toMatch(/ - < '\/.*factory-codex-[^']+'$/);
    expect(rec.calls[0].cmd).toMatch(/ -o '\/.*factory-codex-out-[^']+' - </);
    expect(rec.calls[0].opts.timeoutMs).toBe(timeoutSeconds * 1000);
  });

  it('reports parsed HarnessUsage to ctx.onUsage on the codex route (AC 1, failover attribution)', async () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"019ff914-ffab-7d32-9e8d-2b202a31c34f"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
      '{"type":"turn.completed","usage":{"input_tokens":15785,"cached_input_tokens":9984,"output_tokens":5,"reasoning_output_tokens":0}}',
    ].join('\n');
    const rec = recordingExec({ stdout }, async (cmd) => {
      await realWriteFile(outFileFromCmd(cmd), 'CODEX OUTPUT');
    });
    const executor = new CliModelExecutor(rec.fn);
    const usages: unknown[] = [];

    const output = await executor.runModel('codex-model', 'build it', {
      worktree,
      timeoutSeconds,
      task: 'build_codex',
      registry,
      routesConfig,
      env: { CODEX_HOME: '/nonexistent-codex-home' },
      onUsage: (u) => usages.push(u),
    });
    expect(output).toBe('CODEX OUTPUT');
    expect(usages).toEqual([
      {
        inputTokens: 15785,
        outputTokens: 5,
        rawInputTokens: 5801,
        cacheReadTokens: 9984,
      },
    ]);
  });

  it('runs Ollama through the native chat API with provider options', async () => {
    const calls: { input: string; init: any }[] = [];
    const fetchFn = async (input: string, init: any) => {
      calls.push({ input, init });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '',
        json: async () => ({ message: { content: 'OLLAMA OUTPUT' } }),
      };
    };
    const executor = new CliModelExecutor(recordingExec().fn, fetchFn);

    const output = await executor.runModel('ollama-model', 'draft plan', {
      worktree,
      timeoutSeconds,
      task: 'plan',
      registry,
      routesConfig,
    });

    expect(output).toBe('OLLAMA OUTPUT');
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe('http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(calls[0].init.body);
    expect(body).toEqual({
      model: 'qwen2.5-coder:14b',
      stream: false,
      messages: [{ role: 'user', content: 'draft plan' }],
      options: { num_ctx: 16384, temperature: 0.2 },
    });
  });

  it('rejects with empty_response instead of resolving empty Claude output', async () => {
    const rec = recordingExec();
    const executor = new CliModelExecutor(rec.fn);

    const err: any = await executor
      .runModel('claude-model', 'draft plan', {
        worktree,
        timeoutSeconds,
        task: 'plan',
        registry,
        routesConfig,
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('empty_response');
    expect(err.details.exitCode).toBe(0);
  });

  it('rejects with empty_response instead of resolving empty Ollama output', async () => {
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      json: async () => ({ message: { content: '' } }),
    });
    const executor = new CliModelExecutor(recordingExec().fn, fetchFn);

    const err: any = await executor
      .runModel('ollama-model', 'draft plan', {
        worktree,
        timeoutSeconds,
        task: 'plan',
        registry,
        routesConfig,
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('empty_response');
  });

  it('dispatches through a declared harness instead of inferring from provider', async () => {
    const rec = recordingExec({ stdout: 'CLAUDE OUTPUT' });
    const executor = new CliModelExecutor(rec.fn);

    const output = await executor.runModel('ollama-declared-claude-cli', 'draft plan', {
      worktree,
      timeoutSeconds,
      task: 'plan',
      registry,
      routesConfig,
    });

    expect(output).toBe('CLAUDE OUTPUT');
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].cmd).toContain('claude -p');
    expect(rec.calls[0].cmd).toContain("--model 'claude-sonnet-5'");
  });

  it('dispatches through the opencode harness', async () => {
    const rec = recordingExec({ stdout: 'OC OUT' });
    const executor = new CliModelExecutor(rec.fn);

    const output = await executor.runModel('opencode-declared', 'do it', {
      worktree,
      timeoutSeconds,
      task: 'plan',
      registry,
      routesConfig,
    });

    expect(output).toBe('OC OUT');
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].cmd).toMatch(/^opencode run /);
    expect(rec.calls[0].opts.cwd).toBe(worktree);
  });

  it('records a non-estimated cost row with real tokens for an OpenCode JSON run', async () => {
    const stdout = readFileSync(
      fileURLToPath(new URL('../__fixtures__/opencode/run-json.jsonl', import.meta.url)),
      'utf8',
    );
    const models: ModelsConfig = {
      ...modelsConfig,
      tiers: { boss: ['opencode-declared'] },
    };
    const router = new ModelRouter(models, routesConfig, false, new CliModelExecutor(recordingExec({ stdout }).fn));
    const rows: any[] = [];
    router.setCostSink((e) => rows.push(e));

    await router.run('plan', 'do it', { worktree, timeoutSeconds });

    expect(rows).toHaveLength(1);
    expect(rows[0].estimated).toBe(false);
    expect(rows[0].inputTokens).toBe(9200);
    expect(rows[0].outputTokens).toBe(140);
  });

  it('dispatches through the ollama-agentic harness', async () => {
    tmpWorktree = await mkdtemp(join(tmpdir(), 'factory-ollama-agentic-'));
    const execFn = async (_cmd: string) => ({ stdout: '', stderr: '' });
    const fetchFn = async (_input: string, _init: any) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      json: async () => ({
        message: {
          content: JSON.stringify({
            summary: 'add first-green marker',
            changes: [
              {
                file: 'docs/local-small-first-green.md',
                find: '',
                replace: '# Local-Small First Green\n',
              },
            ],
            verifyCommand: 'test -f docs/local-small-first-green.md',
          }),
        },
      }),
    });
    const executor = new CliModelExecutor(execFn, fetchFn);

    const output = await executor.runModel('ollama-agentic-declared', 'build it', {
      worktree: tmpWorktree,
      timeoutSeconds,
      task: 'build_codex',
      registry,
      routesConfig,
    });

    expect(output).toContain('APPLIED:');
    expect(existsSync(join(tmpWorktree, 'docs/local-small-first-green.md'))).toBe(true);
  });

  it.each(['build_claude', 'build_codex'] as const)(
    'rejects a non-agentic harness on build task %s, naming the model and harness',
    async (task) => {
      const executor = new CliModelExecutor(recordingExec().fn);

      await expect(
        executor.runModel('ollama-model', 'build it', {
          worktree,
          timeoutSeconds,
          task,
          registry,
          routesConfig,
        }),
      ).rejects.toThrow(/ollama-model.*ollama-http.*cannot edit files/s);
    },
  );

  it('rejects with an unknown-model error when the registry has no definition for it', async () => {
    const { fn } = recordingExec();
    const executor = new CliModelExecutor(fn);

    await expect(
      executor.runModel('no-such-model', 'p', {
        worktree,
        timeoutSeconds,
        task: 'plan',
        registry,
        routesConfig,
      }),
    ).rejects.toThrow('Unknown model: no-such-model');
  });

  it('rejects with an unknown-harness error when the declared harness id has no dispatch entry', async () => {
    const { fn } = recordingExec();
    const executor = new CliModelExecutor(fn);
    const bogusHarnessConfig: ModelsConfig = {
      ...modelsConfig,
      models: {
        ...modelsConfig.models,
        'bogus-harness-model': {
          provider: 'custom',
          tier: 'boss',
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
          harness: 'totally-bogus',
        },
      },
    };
    const bogusRegistry = new ModelRegistry(bogusHarnessConfig);

    await expect(
      executor.runModel('bogus-harness-model', 'p', {
        worktree,
        timeoutSeconds,
        task: 'plan',
        registry: bogusRegistry,
        routesConfig,
      }),
    ).rejects.toThrow(/declares unknown harness 'totally-bogus'/);
  });

  it('throws a clear missing-harness error when no harness id resolves', async () => {
    const { fn } = recordingExec();
    const executor = new CliModelExecutor(fn);
    class NoHarnessRegistry extends ModelRegistry {
      override getHarnessId(): undefined {
        return undefined;
      }
    }
    const noHarnessRegistry = new NoHarnessRegistry(modelsConfig);
    await expect(
      executor.runModel('claude-model', 'p', {
        worktree,
        timeoutSeconds,
        task: 'plan',
        registry: noHarnessRegistry,
        routesConfig,
      }),
    ).rejects.toThrow(/has no resolvable harness id/);
  });

  it('classifies rate-limit failures from the exec seam', async () => {
    const executor = new CliModelExecutor(async () => {
      throw Object.assign(new Error('boom'), { stderr: 'rate limit exceeded', code: 1 });
    });

    const err: any = await executor
      .runModel('claude-model', 'draft plan', {
        worktree,
        timeoutSeconds,
        task: 'plan',
        registry,
        routesConfig,
      })
      .catch((e) => e);

    expect(err.reason).toBe('rate_limit');
  });

  it.each([
    ['claude-model', 'plan', '429 too many', 1, 'rate_limit'],
    ['codex-model', 'build_codex', 'quota exceeded', 1, 'usage_cap'],
    ['claude-model', 'plan', 'no content', 1, 'empty_response'],
    ['claude-model', 'plan', 'Error: boom', 1, 'error'],
    ['claude-model', 'plan', 'mysterious', 1, 'unknown'],
  ] as const)('classifies %s %s failure %j/%i as %s', async (model, task, stderr, code, expected) => {
    const executor = new CliModelExecutor(async () => {
      throw Object.assign(new Error('boom'), { stderr, code });
    });

    const err: any = await executor
      .runModel(model, 'prompt', {
        worktree,
        timeoutSeconds,
        task,
        registry,
        routesConfig,
      })
      .catch((e) => e);

    expect(err.reason).toBe(expected);
  });

  it('classifies killed exec failures as timeout', async () => {
    const executor = new CliModelExecutor(async () => {
      throw Object.assign(new Error('killed'), { killed: true });
    });

    const err: any = await executor
      .runModel('claude-model', 'draft plan', {
        worktree,
        timeoutSeconds,
        task: 'plan',
        registry,
        routesConfig,
      })
      .catch((e) => e);

    expect(err.reason).toBe('timeout');
  });

  it('keeps the executor dispatch table in exact sync with HARNESS_CATALOG', () => {
    const executor = new CliModelExecutor(recordingExec().fn);
    // Exact set equality, both directions: a catalog id with no dispatch entry
    // fails (config-valid but runtime-unknown), and a dispatch-only id fails
    // (executor accepts what config validation would reject).
    expect([...executor.supportedHarnessIds()].sort()).toEqual([...KNOWN_HARNESS_IDS].sort());
  });

  it('overriding an existing harness id does not change the supported id set', () => {
    const executor = new CliModelExecutor(recordingExec().fn, undefined, {
      'codex-cli': new StubCodingHarness([], { id: 'codex-cli', defaultOutput: 'stub-output' }),
    });
    expect([...executor.supportedHarnessIds()].sort()).toEqual([...KNOWN_HARNESS_IDS].sort());
  });

  it('dispatches only contract-verified CodingHarness ids (no retired ollama-command-agent in supportedHarnessIds)', () => {
    const ids = new CliModelExecutor(recordingExec().fn).supportedHarnessIds();
    expect(ids).not.toContain(LEGACY_CODEX_OLLAMA_HARNESS);
    // Each id below is built from a CodingHarness class with codingHarnessContractCases coverage.
    const contractVerified = ['claude-cli', 'codex-cli', 'ollama-http', 'opencode', 'pi', 'ollama-agentic', 'command'];
    expect([...ids].sort()).toEqual([...contractVerified].sort());
  });
});

describe('CliModelExecutor retired ollama-command-agent', () => {
  const routesWithPlan: RoutesConfig = { version: 1, routes: { plan: { tier: 'boss', description: 'stub' } } };

  const reachableFetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => '{}',
    json: async () => ({}),
  });

  function routerFor(modelDef: Record<string, unknown>) {
    const config: ModelsConfig = {
      ...modelsConfig,
      models: {
        legacy: { ...modelsConfig.models['ollama-codex-model'], ...modelDef },
      } as ModelsConfig['models'],
      tiers: { boss: ['legacy'] },
    };
    const stub = new StubCodingHarness([], { id: 'ollama-agentic', defaultOutput: 'AGENTIC OUT' });
    const executor = new CliModelExecutor(recordingExec().fn, reachableFetch, { 'ollama-agentic': stub });
    return { stub, router: new ModelRouter(config, routesWithPlan, false, executor) };
  }

  it.each([
    ['codex+ollama inference', {}],
    ['explicit harness', { harness: 'ollama-command-agent' }],
  ])('routes a legacy model (%s) through ollama-agentic and logs the retired-harness notice once', async (_n, def) => {
    const { stub, router } = routerFor(def);
    const logs: string[] = [];

    await router.run('plan', 'p1', { onLog: (m) => logs.push(m) });
    await router.run('plan', 'p2', { onLog: (m) => logs.push(m) });

    expect(stub.calls).toHaveLength(2);
    const notices = logs.filter((l) => l.includes('ollama-agentic') && l.includes('retired'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('ollama-command-agent');
  });

  it('logs no notice for a model already on ollama-agentic', async () => {
    const { stub, router } = routerFor({ harness: 'ollama-agentic' });
    const logs: string[] = [];

    await router.run('plan', 'p1', { onLog: (m) => logs.push(m) });

    expect(stub.calls).toHaveLength(1);
    expect(logs.filter((l) => l.includes('retired'))).toEqual([]);
  });
});

describe('CliModelExecutor declared command harness', () => {
  const declaration = {
    command: 'my-agent --model {model} --cd {worktree}',
    prompt: 'arg',
    output: 'stdout',
    agentic: true,
    usage: 'none',
  } as const;
  const base = {
    provider: 'custom' as const,
    tier: 'boss',
    costPerMtokInput: 0,
    costPerMtokOutput: 0,
    contextWindow: 1000,
    capabilities: [],
    envKey: null,
    codex: true,
  };
  const declaredRegistry = (harnesses: ModelsConfig['harnesses']) =>
    new ModelRegistry({
      ...modelsConfig,
      models: {
        mine: { ...base, harness: 'my-agent', providerModel: 'prov/model' },
        chat: { ...base, harness: 'chat-agent' },
        bare: { ...base, harness: 'command' },
      },
      tiers: { boss: ['mine', 'chat', 'bare'] },
      harnesses,
    });

  it('dispatches a declared id to the command harness with the substituted command and cwd', async () => {
    const rec = recordingExec({ stdout: 'AGENT OUTPUT' });
    const executor = new CliModelExecutor(rec.fn);
    const out = await executor.runModel('mine', 'do it', {
      worktree,
      timeoutSeconds,
      task: 'build_codex',
      registry: declaredRegistry({ 'my-agent': declaration }),
      routesConfig,
    });
    expect(out).toBe('AGENT OUTPUT');
    expect(rec.calls[0].cmd).toBe(`my-agent --model 'prov/model' --cd '${worktree}' 'do it' < /dev/null`);
    expect(rec.calls[0].opts.cwd).toBe(worktree);
  });

  it('rejects a declared non-agentic harness for a build task', async () => {
    const executor = new CliModelExecutor(recordingExec().fn);
    await expect(
      executor.runModel('chat', 'x', {
        worktree,
        timeoutSeconds,
        task: 'build_codex',
        registry: declaredRegistry({ 'chat-agent': { ...declaration, agentic: false } }),
        routesConfig,
      }),
    ).rejects.toThrow(/non-agentic harness 'chat-agent'/);
  });

  it("throws a clear error for harness 'command' with no declaration", async () => {
    const executor = new CliModelExecutor(recordingExec().fn);
    await expect(
      executor.runModel('bare', 'x', {
        worktree,
        timeoutSeconds,
        task: 'plan',
        registry: declaredRegistry({ 'my-agent': declaration }),
        routesConfig,
      }),
    ).rejects.toThrow(/command harness, which needs a matching entry under 'harnesses'/);
  });
});

describe('CliModelExecutor harness injection', () => {
  it('lets an injected harness handle the run for its id', async () => {
    const rec = recordingExec({ stdout: 'REAL CLAUDE' });
    const fake = { calls: [] as { model: string; prompt: string }[] };
    const executor = new CliModelExecutor(rec.fn, undefined, {
      'claude-cli': {
        id: 'claude-cli',
        agentic: true,
        run: async ({ model, prompt }) => {
          fake.calls.push({ model, prompt });
          return { output: 'FAKE HARNESS OUTPUT' };
        },
      },
    });

    const output = await executor.runModel('claude-model', 'draft plan', {
      worktree,
      timeoutSeconds,
      task: 'plan',
      registry,
      routesConfig,
    });

    expect(output).toBe('FAKE HARNESS OUTPUT');
    expect(fake.calls).toEqual([{ model: 'claude-model', prompt: 'draft plan' }]);
    expect(rec.calls).toEqual([]);
  });

  it('leaves other default harnesses intact when only one id is overridden', async () => {
    const rec = recordingExec({ stdout: 'OC OUT' });
    const executor = new CliModelExecutor(rec.fn, undefined, {
      'claude-cli': new StubCodingHarness([], { id: 'claude-cli', defaultOutput: 'FAKE HARNESS OUTPUT' }),
    });

    const output = await executor.runModel('opencode-declared', 'do it', {
      worktree,
      timeoutSeconds,
      task: 'plan',
      registry,
      routesConfig,
    });

    expect(output).toBe('OC OUT');
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].cmd).toMatch(/^opencode run /);
  });

  it('lets the injected map add a brand-new harness id', async () => {
    const fakeHarnessModelsConfig: ModelsConfig = {
      ...modelsConfig,
      models: {
        ...modelsConfig.models,
        'fake-harness-model': {
          provider: 'custom',
          tier: 'boss',
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
          harness: 'fake-harness',
        },
      },
      tiers: {
        boss: [...modelsConfig.tiers.boss, 'fake-harness-model'],
      },
    };
    const fakeHarnessRegistry = new ModelRegistry(fakeHarnessModelsConfig);
    const executor = new CliModelExecutor(recordingExec().fn, undefined, {
      'fake-harness': new StubCodingHarness([], { id: 'fake-harness', agentic: false, defaultOutput: 'NEW ID OUTPUT' }),
    });

    const output = await executor.runModel('fake-harness-model', 'draft plan', {
      worktree,
      timeoutSeconds,
      task: 'plan',
      registry: fakeHarnessRegistry,
      routesConfig,
    });

    expect(output).toBe('NEW ID OUTPUT');

    await expect(
      executor.runModel('fake-harness-model', 'build it', {
        worktree,
        timeoutSeconds,
        task: 'build_claude',
        registry: fakeHarnessRegistry,
        routesConfig,
      }),
    ).rejects.toThrow(/cannot edit files/);
  });
});

describe('CliModelExecutor shared empty-response propagation', () => {
  const emptyOllamaFetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => '',
    json: async () => ({ message: { content: '' } }),
  });

  it.each([
    ['claude-cli', 'claude-model', 'plan'],
    ['codex-cli', 'codex-model', 'build_codex'],
    ['opencode', 'opencode-declared', 'plan'],
  ] as const)(
    'propagates an empty_response from %s instead of resolving empty output',
    async (_harness, model, task) => {
      const executor = new CliModelExecutor(recordingExec().fn);
      const err: any = await executor
        .runModel(model, 'prompt', {
          worktree,
          timeoutSeconds,
          task,
          registry,
          routesConfig,
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(HarnessError);
      expect(err.reason).toBe('empty_response');
    },
  );

  it('propagates an empty_response from ollama-http instead of resolving empty output', async () => {
    const executor = new CliModelExecutor(recordingExec().fn, emptyOllamaFetch as any);
    const err: any = await executor
      .runModel('ollama-model', 'prompt', {
        worktree,
        timeoutSeconds,
        task: 'plan',
        registry,
        routesConfig,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('empty_response');
  });

  it('propagates an empty_response from ollama-agentic instead of resolving empty output', async () => {
    tmpWorktree = await mkdtemp(join(tmpdir(), 'factory-empty-agentic-'));
    const executor = new CliModelExecutor(recordingExec().fn, emptyOllamaFetch as any);
    const err: any = await executor
      .runModel('ollama-agentic-declared', 'prompt', {
        worktree: tmpWorktree,
        timeoutSeconds,
        task: 'build_codex',
        registry,
        routesConfig,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('empty_response');
  });

  describe('probeOllama', () => {
    beforeEach(resetOllamaProbeCache);

    it('uses the injected fetchFn to GET /api/version', async () => {
      const urls: string[] = [];
      const fetchFn = async (input: string) => {
        urls.push(input);
        return { ok: true, status: 200 } as any;
      };
      const executor = new CliModelExecutor(recordingExec().fn, fetchFn);

      const result = await executor.probeOllama();

      expect(result.reachable).toBe(true);
      expect(urls).toHaveLength(1);
      expect(urls[0]).toMatch(/\/api\/version$/);
    });
  });
});
