import { describe, expect, it } from 'vitest';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import { CliModelExecutor } from './index.js';

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
  },
  tiers: { boss: ['claude-model', 'claude-no-flag', 'codex-model', 'ollama-model', 'ollama-codex-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
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
const timeout = 7;

function recordingExec(result: { stdout?: string; stderr?: string } = {}) {
  const calls: { cmd: string; opts: any }[] = [];
  const fn = async (cmd: string, opts: any) => {
    calls.push({ cmd, opts });
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { fn, calls };
}

describe('CliModelExecutor', () => {
  it('runs Claude with the expected invocation shape', async () => {
    const rec = recordingExec({ stdout: 'CLAUDE OUTPUT' });
    const executor = new CliModelExecutor(rec.fn);

    const output = await executor.runModel('claude-model', 'draft plan', {
      worktree,
      timeout,
      task: 'plan',
      registry,
      routesConfig,
    });

    expect(output).toBe('CLAUDE OUTPUT');
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].cmd).toContain('claude -p');
    expect(rec.calls[0].cmd).toContain("'draft plan'");
    expect(rec.calls[0].cmd).toContain('--model claude-sonnet-5');
    expect(rec.calls[0].cmd).toContain('--dangerously-skip-permissions');
    expect(rec.calls[0].opts.cwd).toBe(worktree);
    expect(rec.calls[0].opts.timeout).toBe(timeout * 1000);
  });

  it('runs Claude without a model flag when none is configured', async () => {
    const rec = recordingExec();
    const executor = new CliModelExecutor(rec.fn);

    await executor.runModel('claude-no-flag', 'draft plan', {
      worktree,
      timeout,
      task: 'plan',
      registry,
      routesConfig,
    });

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].cmd).toContain('claude -p');
    expect(rec.calls[0].cmd).not.toMatch(/(^|\s)--model(\s|$)/);
    expect(rec.calls[0].cmd).toContain('--dangerously-skip-permissions');
  });

  it('runs Codex with flags, output file, and prompt-file stdin redirect', async () => {
    const rec = recordingExec();
    const executor = new CliModelExecutor(rec.fn);

    const output = await executor.runModel('codex-model', 'build it', {
      worktree,
      timeout,
      task: 'build_codex',
      registry,
      routesConfig,
    });

    expect(output).toBe('');
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].cmd).toMatch(/^codex exec --sandbox workspace-write --ask-for-approval never -C '/);
    expect(rec.calls[0].cmd).toContain(`-C '${worktree}'`);
    expect(rec.calls[0].cmd).toContain('--model gpt-5-codex');
    expect(rec.calls[0].cmd).toContain(' -o ');
    expect(rec.calls[0].cmd).toMatch(/ - < '\/.*factory-codex-[^']+'$/);
    expect(rec.calls[0].cmd).toMatch(/ -o '\/.*factory-codex-out-[^']+' - </);
    expect(rec.calls[0].opts.timeout).toBe(timeout * 1000);
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
      timeout,
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

  it('runs a codex-enabled Ollama model through the local command loop for codex tasks', async () => {
    const execCalls: string[] = [];
    const execFn = async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd === 'git status --short') return { stdout: '', stderr: '' };
      return { stdout: 'ok', stderr: '' };
    };
    const fetchCalls: string[] = [];
    const fetchFn = async (_input: string, init: any) => {
      fetchCalls.push(init.body);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '',
        json: async () => ({
          message: {
            content: fetchCalls.length === 1
              ? '{"commands":["printf hello > local.txt"],"done":false,"final":"created"}'
              : '{"commands":[],"done":true,"final":"done"}',
          },
        }),
      };
    };
    const executor = new CliModelExecutor(execFn, fetchFn);

    const output = await executor.runModel('ollama-codex-model', 'build it', {
      worktree,
      timeout,
      task: 'build_codex',
      registry,
      routesConfig,
    });

    expect(output).toContain('MODEL STEP 1');
    expect(execCalls).toEqual(['git status --short', 'printf hello > local.txt', 'git status --short']);
  });

  it('feeds non-zero local command exits back into the Ollama command loop as observations', async () => {
    const execCalls: string[] = [];
    const execFn = async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd === 'missing-command') {
        throw Object.assign(new Error('not found'), {
          code: 127,
          stdout: '',
          stderr: 'command not found',
        });
      }
      if (cmd === 'git status --short') return { stdout: '', stderr: '' };
      return { stdout: 'ok', stderr: '' };
    };
    const fetchCalls: string[] = [];
    const fetchFn = async (_input: string, init: any) => {
      fetchCalls.push(init.body);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '',
        json: async () => ({
          message: {
            content: fetchCalls.length === 1
              ? '{"commands":["missing-command"],"done":false,"final":"inspect failed"}'
              : '{"commands":[],"done":true,"final":"handled failure"}',
          },
        }),
      };
    };
    const executor = new CliModelExecutor(execFn, fetchFn);

    const output = await executor.runModel('ollama-codex-model', 'build it', {
      worktree,
      timeout,
      task: 'build_codex',
      registry,
      routesConfig,
    });

    expect(output).toContain('EXIT_CODE: 127');
    expect(output).toContain('command not found');
    expect(fetchCalls).toHaveLength(2);
    expect(execCalls).toEqual(['git status --short', 'missing-command', 'git status --short']);
  });

  it('auto-commits only paths that became dirty during the local command loop', async () => {
    const execCalls: string[] = [];
    const execFn = async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd === 'git status --short' && execCalls.length === 1) {
        return { stdout: '?? preexisting.txt\n', stderr: '' };
      }
      if (cmd === 'git status --short') {
        return { stdout: '?? preexisting.txt\n M fresh.txt\n', stderr: '' };
      }
      return { stdout: 'ok', stderr: '' };
    };
    const fetchCalls: string[] = [];
    const fetchFn = async (_input: string, init: any) => {
      fetchCalls.push(init.body);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '',
        json: async () => ({
          message: {
            content: fetchCalls.length === 1
              ? '{"commands":["printf ok > fresh.txt"],"done":false,"final":"created"}'
              : '{"commands":[],"done":true,"final":"done"}',
          },
        }),
      };
    };
    const executor = new CliModelExecutor(execFn, fetchFn);

    const output = await executor.runModel('ollama-codex-model', 'build it', {
      worktree,
      timeout,
      task: 'build_codex',
      registry,
      routesConfig,
    });

    expect(output).toContain('AUTO-COMMIT: committed 1 changed path(s).');
    expect(execCalls).toContain("git add -- 'fresh.txt' && git commit -m \"feat: implement factory issue\"");
    expect(execCalls).not.toContain("git add -- 'preexisting.txt' && git commit -m \"feat: implement factory issue\"");
  });

  it('classifies rate-limit failures from the exec seam', async () => {
    const executor = new CliModelExecutor(async () => {
      throw Object.assign(new Error('boom'), { stderr: 'rate limit exceeded', code: 1 });
    });

    const err: any = await executor.runModel('claude-model', 'draft plan', {
      worktree,
      timeout,
      task: 'plan',
      registry,
      routesConfig,
    }).catch(e => e);

    expect(err.reason).toBe('rate_limit');
  });

  it.each([
    ['claude-model', 'plan', '429 too many', 1, 'rate_limit'],
    ['codex-model', 'build_codex', 'quota exceeded', 1, 'usage_cap'],
    ['claude-model', 'plan', 'no content', 1, 'empty_response'],
    ['claude-model', 'plan', 'Error: boom', 1, 'error'],
    ['claude-model', 'plan', 'mysterious', 1, 'unknown'],
  ] as const)(
    'classifies %s %s failure %j/%i as %s',
    async (model, task, stderr, code, expected) => {
      const executor = new CliModelExecutor(async () => {
        throw Object.assign(new Error('boom'), { stderr, code });
      });

      const err: any = await executor.runModel(model, 'prompt', {
        worktree,
        timeout,
        task,
        registry,
        routesConfig,
      }).catch(e => e);

      expect(err.reason).toBe(expected);
    },
  );

  it('classifies killed exec failures as timeout', async () => {
    const executor = new CliModelExecutor(async () => {
      throw Object.assign(new Error('killed'), { killed: true });
    });

    const err: any = await executor.runModel('claude-model', 'draft plan', {
      worktree,
      timeout,
      task: 'plan',
      registry,
      routesConfig,
    }).catch(e => e);

    expect(err.reason).toBe('timeout');
  });
});
