import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { HarnessError, KNOWN_HARNESS_IDS } from '../harness/index.js';
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
const timeoutSeconds = 7;
let tmpWorktree: string | undefined;

afterEach(async () => {
  if (tmpWorktree) {
    await rm(tmpWorktree, { recursive: true, force: true });
    tmpWorktree = undefined;
  }
});

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
      timeoutSeconds,
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
    expect(rec.calls[0].opts.timeoutMs).toBe(timeoutSeconds * 1000);
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
    expect(rec.calls[0].cmd).toContain('--dangerously-skip-permissions');
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
    expect(rec.calls[0].cmd).toMatch(/^codex exec --sandbox workspace-write --ask-for-approval never -C '/);
    expect(rec.calls[0].cmd).toContain(`-C '${worktree}'`);
    expect(rec.calls[0].cmd).toContain('--model gpt-5-codex');
    expect(rec.calls[0].cmd).toContain(' -o ');
    expect(rec.calls[0].cmd).toMatch(/ - < '\/.*factory-codex-[^']+'$/);
    expect(rec.calls[0].cmd).toMatch(/ -o '\/.*factory-codex-out-[^']+' - </);
    expect(rec.calls[0].opts.timeoutMs).toBe(timeoutSeconds * 1000);
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
    expect(rec.calls[0].cmd).toContain('--model claude-sonnet-5');
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
            content:
              fetchCalls.length === 1
                ? '{"commands":["printf hello > local.txt"],"done":false,"final":"created"}'
                : '{"commands":[],"done":true,"final":"done"}',
          },
        }),
      };
    };
    const executor = new CliModelExecutor(execFn, fetchFn);

    const output = await executor.runModel('ollama-codex-model', 'build it', {
      worktree,
      timeoutSeconds,
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
            content:
              fetchCalls.length === 1
                ? '{"commands":["missing-command"],"done":false,"final":"inspect failed"}'
                : '{"commands":[],"done":true,"final":"handled failure"}',
          },
        }),
      };
    };
    const executor = new CliModelExecutor(execFn, fetchFn);

    const output = await executor.runModel('ollama-codex-model', 'build it', {
      worktree,
      timeoutSeconds,
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
            content:
              fetchCalls.length === 1
                ? '{"commands":["printf ok > fresh.txt"],"done":false,"final":"created"}'
                : '{"commands":[],"done":true,"final":"done"}',
          },
        }),
      };
    };
    const executor = new CliModelExecutor(execFn, fetchFn);

    const output = await executor.runModel('ollama-codex-model', 'build it', {
      worktree,
      timeoutSeconds,
      task: 'build_codex',
      registry,
      routesConfig,
    });

    expect(output).toContain('AUTO-COMMIT: committed 1 changed path(s).');
    expect(execCalls).toContain('git add -- \'fresh.txt\' && git commit -m "feat: implement factory issue"');
    expect(execCalls).not.toContain('git add -- \'preexisting.txt\' && git commit -m "feat: implement factory issue"');
  });

  it('retries an empty local command-agent response with a compact repair prompt', async () => {
    tmpWorktree = await mkdtemp(join(tmpdir(), 'factory-command-agent-'));
    const execCalls: string[] = [];
    const execFn = async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd === 'git status --short') return { stdout: '', stderr: '' };
      return { stdout: 'ok', stderr: '' };
    };
    const prompts: string[] = [];
    const responses = [
      '',
      '{"commands":["printf repaired > local.txt"],"done":false,"final":"repaired"}',
      '{"commands":[],"done":true,"final":"done"}',
    ];
    const fetchFn = async (_input: string, init: any) => {
      const body = JSON.parse(init.body);
      prompts.push(body.messages[0].content);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '',
        json: async () => ({
          message: {
            content: responses.shift(),
          },
        }),
      };
    };
    const executor = new CliModelExecutor(execFn, fetchFn);

    const output = await executor.runModel('ollama-codex-model', 'build it', {
      worktree: tmpWorktree,
      timeoutSeconds,
      task: 'build_codex',
      registry,
      routesConfig,
    });

    expect(output).toContain('REPAIR STEP 1');
    expect(prompts[1]).toContain('Return exactly one JSON object');
    expect(execCalls).toEqual(['git status --short', 'printf repaired > local.txt', 'git status --short']);
  });

  it('accepts command objects from local command-agent responses', async () => {
    tmpWorktree = await mkdtemp(join(tmpdir(), 'factory-command-agent-'));
    const execCalls: string[] = [];
    const execFn = async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd === 'git status --short') return { stdout: '', stderr: '' };
      return { stdout: 'ok', stderr: '' };
    };
    const responses = [
      '{"commands":[{"command":"printf object-command > local.txt","name":"write_file"}],"done":false,"final":"wrote"}',
      '{"commands":[],"done":true,"final":"done"}',
    ];
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      json: async () => ({ message: { content: responses.shift() } }),
    });
    const executor = new CliModelExecutor(execFn, fetchFn as any);

    const output = await executor.runModel('ollama-codex-model', 'build it', {
      worktree: tmpWorktree,
      timeoutSeconds,
      task: 'build_codex',
      registry,
      routesConfig,
    });

    expect(output).toContain('MODEL STEP 1');
    expect(execCalls).toEqual(['git status --short', 'printf object-command > local.txt', 'git status --short']);
  });

  it('accepts command objects with args from local command-agent responses', async () => {
    tmpWorktree = await mkdtemp(join(tmpdir(), 'factory-command-agent-'));
    const execCalls: string[] = [];
    const execFn = async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd === 'git status --short') return { stdout: '', stderr: '' };
      return { stdout: 'ok', stderr: '' };
    };
    const responses = [
      '{"commands":[{"command":"cat","args":["docs/revenue-model.md"],"description":"read doc"}],"done":false,"final":"read"}',
      '{"commands":[],"done":true,"final":"done"}',
    ];
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      json: async () => ({ message: { content: responses.shift() } }),
    });
    const executor = new CliModelExecutor(execFn, fetchFn as any);

    await executor.runModel('ollama-codex-model', 'build it', {
      worktree: tmpWorktree,
      timeoutSeconds,
      task: 'build_codex',
      registry,
      routesConfig,
    });

    expect(execCalls).toEqual(['git status --short', "cat 'docs/revenue-model.md'", 'git status --short']);
  });

  it('accepts name/args command objects from local command-agent responses', async () => {
    tmpWorktree = await mkdtemp(join(tmpdir(), 'factory-command-agent-'));
    const execCalls: string[] = [];
    const execFn = async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd === 'git status --short') return { stdout: '', stderr: '' };
      return { stdout: 'ok', stderr: '' };
    };
    const responses = [
      '{"commands":[{"name":"cat","args":["docs/revenue-model.md"]}],"done":false,"final":"read"}',
      '{"commands":[],"done":true,"final":"done"}',
    ];
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      json: async () => ({ message: { content: responses.shift() } }),
    });
    const executor = new CliModelExecutor(execFn, fetchFn as any);

    await executor.runModel('ollama-codex-model', 'build it', {
      worktree: tmpWorktree,
      timeoutSeconds,
      task: 'build_codex',
      registry,
      routesConfig,
    });

    expect(execCalls).toEqual(['git status --short', "cat 'docs/revenue-model.md'", 'git status --short']);
  });

  it('retries invalid JSON and succeeds when the repair response is valid', async () => {
    tmpWorktree = await mkdtemp(join(tmpdir(), 'factory-command-agent-'));
    const execFn = async (cmd: string) => {
      if (cmd === 'git status --short') return { stdout: '', stderr: '' };
      return { stdout: 'ok', stderr: '' };
    };
    const responses = ['{"commands":[', '{"commands":[],"done":true,"final":"done"}'];
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      json: async () => ({ message: { content: responses.shift() } }),
    });
    const executor = new CliModelExecutor(execFn, fetchFn as any);

    const output = await executor.runModel('ollama-codex-model', 'build it', {
      worktree: tmpWorktree,
      timeoutSeconds,
      task: 'build_codex',
      registry,
      routesConfig,
    });

    expect(output).toContain('REPAIR STEP 1');
  });

  it('writes an actionable trace when local command-agent repair is exhausted', async () => {
    tmpWorktree = await mkdtemp(join(tmpdir(), 'factory-command-agent-'));
    const execFn = async (cmd: string) => {
      if (cmd === 'git status --short') return { stdout: '', stderr: '' };
      return { stdout: 'ok', stderr: '' };
    };
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      json: async () => ({ message: { content: '' } }),
    });
    const executor = new CliModelExecutor(execFn, fetchFn as any);

    const err: any = await executor
      .runModel('ollama-codex-model', 'build it', {
        worktree: tmpWorktree,
        timeoutSeconds,
        task: 'build_codex',
        registry,
        routesConfig,
      })
      .catch((e) => e);

    expect(err.reason).toBe('empty_response');
    expect(err.message).toContain('trace written to');
    const traceDir = join(tmpWorktree, '.factory', 'local-agent-traces');
    const traceFiles = readdirSync(traceDir);
    expect(traceFiles.some((file) => file.endsWith('.json'))).toBe(true);
    expect(traceFiles.some((file) => file.endsWith('-repair-prompt.md'))).toBe(true);
    const trace = JSON.parse(
      readFileSync(
        join(
          traceDir,
          traceFiles.find((file) => file.endsWith('.json'))!,
        ),
        'utf-8',
      ),
    );
    expect(trace).toMatchObject({
      model: 'ollama-codex-model',
      attempt: 1,
      promptSize: 'build it'.length,
      malformedReason: 'empty_response',
    });
    expect(existsSync(trace.retryPromptPath)).toBe(true);
  });

  it('keeps the malformed-output trace when local command-agent repair fails', async () => {
    tmpWorktree = await mkdtemp(join(tmpdir(), 'factory-command-agent-'));
    const execFn = async (cmd: string) => {
      if (cmd === 'git status --short') return { stdout: '', stderr: '' };
      return { stdout: 'ok', stderr: '' };
    };
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => '',
          json: async () => ({ message: { content: '{"commands":[' } }),
        };
      }
      throw Object.assign(new Error('ollama repair transport failed'), { reason: 'error' });
    };
    const executor = new CliModelExecutor(execFn, fetchFn as any);

    const err: any = await executor
      .runModel('ollama-codex-model', 'build it', {
        worktree: tmpWorktree,
        timeoutSeconds,
        task: 'build_codex',
        registry,
        routesConfig,
      })
      .catch((e) => e);

    expect(err.reason).toBe('error');
    expect(err.details.tracePath).toBeTruthy();
    expect(err.message).toContain('trace written to');
    expect(err.message).toContain('repair error: ollama repair transport failed');
    expect(existsSync(err.details.tracePath)).toBe(true);
  });

  it('writes a trace when the local command-agent Ollama call fails before output', async () => {
    tmpWorktree = await mkdtemp(join(tmpdir(), 'factory-command-agent-'));
    const execFn = async (cmd: string) => {
      if (cmd === 'git status --short') return { stdout: '', stderr: '' };
      return { stdout: 'ok', stderr: '' };
    };
    const fetchFn = async () => {
      throw Object.assign(new Error('ollama socket closed'), { reason: 'error' });
    };
    const executor = new CliModelExecutor(execFn, fetchFn as any);

    const err: any = await executor
      .runModel('ollama-codex-model', 'build it', {
        worktree: tmpWorktree,
        timeoutSeconds,
        task: 'build_codex',
        registry,
        routesConfig,
      })
      .catch((e) => e);

    expect(err.reason).toBe('error');
    expect(err.details.tracePath).toBeTruthy();
    expect(err.message).toContain('local command-agent model call failed');
    expect(err.message).toContain('trace written to');
    const trace = JSON.parse(readFileSync(err.details.tracePath, 'utf-8'));
    expect(trace).toMatchObject({
      model: 'ollama-codex-model',
      attempt: 1,
      failureReason: 'error',
      errorMessage: 'ollama socket closed',
    });
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
      'codex-cli': { run: async () => 'stub-output' },
    });
    expect([...executor.supportedHarnessIds()].sort()).toEqual([...KNOWN_HARNESS_IDS].sort());
  });
});

describe('CliModelExecutor harness injection', () => {
  it('lets an injected harness handle the run for its id', async () => {
    const rec = recordingExec({ stdout: 'REAL CLAUDE' });
    const fake = { calls: [] as { model: string; prompt: string }[] };
    const executor = new CliModelExecutor(rec.fn, undefined, {
      'claude-cli': {
        run: async (model, prompt) => {
          fake.calls.push({ model, prompt });
          return 'FAKE HARNESS OUTPUT';
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
      'claude-cli': { run: async () => 'FAKE HARNESS OUTPUT' },
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
      'fake-harness': { run: async () => 'NEW ID OUTPUT' },
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
});
