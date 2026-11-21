import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import type { ExecFn } from '../utils/exec.js';
import { codingHarnessContractCases, makeContractRequest } from './contract.js';
import {
  buildCopilotCommand,
  COPILOT_CHILD_ENV_REMOVALS,
  copilotAllowAllDecision,
  CopilotCliHarness,
  parseCopilotJson,
} from './copilot-cli.js';
import type { HarnessRequest } from './index.js';
import { HarnessError } from './index.js';

const policy = (runtime: SandboxPolicy['runtime']): SandboxPolicy => ({
  runtime,
  worktree: '/tmp/wt',
  writablePaths: ['/tmp/wt'],
  writableFilePrefixes: [],
  allowHosts: [],
  cpuMs: 300_000,
  memMb: 4096,
});

const modelBase: ModelsConfig['models'][string] = {
  provider: 'copilot',
  tier: [],
  costPerMtokInput: 0,
  costPerMtokOutput: 0,
  contextWindow: 128000,
  capabilities: [],
  envKey: null,
  harness: 'copilot-cli',
};

const registry = new ModelRegistry({
  version: 1,
  models: { 'copilot-default': modelBase, 'copilot-pinned': { ...modelBase, providerModel: 'gpt-5.4' } },
  tiers: {},
  failover: { triggers: [], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
});

const line = (event: Record<string, unknown>) => JSON.stringify(event);
const message = (content: string, extra: Record<string, unknown> = {}) =>
  line({ type: 'assistant.message', data: { messageId: 'm', content, toolRequests: [], ...extra } });
const usage = (inputTokens: number, outputTokens: number, cacheReadTokens?: number) =>
  line({ type: 'assistant.usage', data: { inputTokens, outputTokens, cacheReadTokens } });
const transcript = (...lines: string[]) => `${lines.join('\n')}\n`;

const SUCCESS = transcript(
  line({ type: 'assistant.message_delta', data: { messageId: 'm', deltaContent: 'Wor' } }),
  line({ type: 'tool.execution_start', data: { toolCallId: 't', toolName: 'bash', arguments: { command: 'ls' } } }),
  line({ type: 'tool.execution_complete', data: { toolCallId: 't', success: true } }),
  usage(100, 20, 40),
  message('Work done.'),
  usage(50, 10),
  line({ type: 'result', exitCode: 0 }),
);

interface Recorded {
  cmd: string;
  opts: Parameters<ExecFn>[1];
}

const recordingExec = (stdout: string) => {
  const calls: Recorded[] = [];
  const fn: ExecFn = async (cmd, opts) => {
    calls.push({ cmd, opts });
    return { stdout, stderr: '' };
  };
  return Object.assign(fn, { calls });
};

const failingExec =
  (fields: Record<string, unknown>): ExecFn =>
  async () => {
    throw Object.assign(new Error('Command failed'), fields);
  };

const quiet = { log: () => {} };
const request = (overrides: Partial<HarnessRequest> = {}) =>
  makeContractRequest({ model: 'copilot-default', registry, task: 'build_copilot', ...overrides });

async function rejection(harness: CopilotCliHarness, overrides: Partial<HarnessRequest> = {}): Promise<HarnessError> {
  const err = await harness.run(request(overrides)).catch((e: unknown) => e);
  if (!(err instanceof HarnessError)) throw new Error(`expected a HarnessError, got ${String(err)}`);
  return err;
}

describe('CodingHarness contract: CopilotCliHarness', () => {
  const cases = codingHarnessContractCases({
    success: () => ({ harness: new CopilotCliHarness(recordingExec(SUCCESS), quiet), request: request() }),
    timeout: () => ({
      harness: new CopilotCliHarness(failingExec({ killed: true, signal: 'SIGTERM' }), quiet),
      request: request(),
    }),
    emptyOutput: () => ({ harness: new CopilotCliHarness(recordingExec(''), quiet), request: request() }),
    failure: () => ({
      harness: new CopilotCliHarness(failingExec({ code: 1, stderr: 'Error: Authentication failed' }), quiet),
      request: request(),
    }),
  });
  for (const contractCase of cases) it(contractCase.name, contractCase.run);
});

describe('buildCopilotCommand', () => {
  it('reads the prompt from a file on stdin and always passes --no-ask-user and the hardening flags', () => {
    const cmd = buildCopilotCommand({ allowAll: false, promptPath: '/tmp/p dir/prompt.txt' });
    expect(cmd).toBe(
      "copilot --output-format json --stream off --no-ask-user --no-auto-update --disable-builtin-mcps --secret-env-vars=COPILOT_GITHUB_TOKEN < '/tmp/p dir/prompt.txt'",
    );
  });

  it('adds --allow-all only when granted and --model only for a provider model', () => {
    const cmd = buildCopilotCommand({ allowAll: true, providerModel: 'gpt-5.4', promptPath: '/tmp/p.txt' });
    expect(cmd).toContain(' --allow-all --model ');
    expect(cmd.endsWith("--model 'gpt-5.4' < '/tmp/p.txt'")).toBe(true);
  });
});

describe('copilotAllowAllDecision', () => {
  it.each(['sandbox-exec', 'firejail'] as const)('grants --allow-all under the %s OS sandbox', (runtime) => {
    expect(copilotAllowAllDecision({ sandbox: policy(runtime) }).allowAll).toBe(true);
  });

  it.each([
    ['no sandbox', undefined],
    ['runtime none', policy('none')],
    ['docker-sandbox, which wraps nothing yet', policy('docker-sandbox')],
  ])('refuses --allow-all with %s and no config opt-in', (_label, sandbox) => {
    expect(copilotAllowAllDecision({ sandbox }).allowAll).toBe(false);
    expect(copilotAllowAllDecision({ sandbox, copilotAllowAll: false }).allowAll).toBe(false);
  });

  it('grants --allow-all with sandbox.copilotAllowAll: true even without a containing runtime', () => {
    expect(copilotAllowAllDecision({ sandbox: policy('none'), copilotAllowAll: true })).toEqual({
      allowAll: true,
      why: 'sandbox.copilotAllowAll: true in config',
    });
  });
});

describe('CopilotCliHarness.run', () => {
  it('runs in the worktree with the prompt only in a temp file, copilotAuth on and approval env vars removed', async () => {
    const exec = recordingExec(SUCCESS);
    const result = await new CopilotCliHarness(exec, quiet).run(
      request({ prompt: 'SECRET PROMPT TEXT', worktree: '/tmp/wt', env: { PORT: '3142', COPILOT_ALLOW_ALL: 'true' } }),
    );
    const [call] = exec.calls;
    expect(result.output).toBe('Work done.');
    expect(call?.cmd).not.toContain('SECRET PROMPT TEXT');
    expect(call?.cmd).not.toContain('--allow-all');
    expect(call?.cmd).not.toContain('--model');
    expect(call?.opts.cwd).toBe('/tmp/wt');
    expect(call?.opts.copilotAuth).toBe(true);
    expect(call?.opts.githubAuth).toBeUndefined();
    expect(call?.opts.env?.PORT).toBe('3142');
    for (const name of COPILOT_CHILD_ENV_REMOVALS) {
      expect(Object.hasOwn(call?.opts.env ?? {}, name)).toBe(true);
      expect(call?.opts.env?.[name]).toBeUndefined();
    }
  });

  it('removes the allow-all, assisted-approval and prompt-mode extensions variables a lane env carries', async () => {
    const exec = recordingExec(SUCCESS);
    await new CopilotCliHarness(exec, quiet).run(
      request({
        env: {
          COPILOT_ALLOW_ALL: 'true',
          COPILOT_ASSISTED_APPROVAL: 'true',
          GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: 'true',
        },
      }),
    );
    const env = exec.calls[0]?.opts.env ?? {};
    expect(Object.hasOwn(env, 'COPILOT_ALLOW_ALL')).toBe(true);
    expect(env.COPILOT_ALLOW_ALL).toBeUndefined();
    expect(Object.hasOwn(env, 'COPILOT_ASSISTED_APPROVAL')).toBe(true);
    expect(env.COPILOT_ASSISTED_APPROVAL).toBeUndefined();
    expect(Object.hasOwn(env, 'GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS')).toBe(true);
    expect(env.GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS).toBeUndefined();
  });

  it('passes --allow-all with an effective sandbox and with the opt-in, and logs the decision once per task', async () => {
    const lines: string[] = [];
    const exec = recordingExec(SUCCESS);
    const harness = new CopilotCliHarness(exec, { log: (l) => lines.push(l) });
    await harness.run(request({ sandbox: policy('sandbox-exec') }));
    await harness.run(request({ sandbox: policy('sandbox-exec') }));
    await harness.run(request({ task: 'plan', copilotAllowAll: true }));
    expect(exec.calls.map((c) => c.cmd.includes(' --allow-all'))).toEqual([true, true, true]);
    expect(exec.calls[0]?.cmd.startsWith('sandbox-exec ')).toBe(true);
    expect(lines).toEqual([
      'copilot: --allow-all for task build_copilot (the sandbox-exec OS sandbox contains the run)',
      'copilot: --allow-all for task plan (sandbox.copilotAllowAll: true in config)',
    ]);
  });

  it('logs the refusal when no sandbox contains the run', async () => {
    const lines: string[] = [];
    await new CopilotCliHarness(recordingExec(SUCCESS), { log: (l) => lines.push(l) }).run(
      request({ sandbox: policy('none') }),
    );
    expect(lines).toEqual([
      'copilot: no --allow-all for task build_copilot (sandbox runtime none does not contain the run); tool calls that need approval are denied',
    ]);
  });

  it('sends --model only for a registry providerModel, never the registry id', async () => {
    const exec = recordingExec(SUCCESS);
    await new CopilotCliHarness(exec, quiet).run(request({ model: 'copilot-pinned' }));
    expect(exec.calls[0]?.cmd).toContain("--model 'gpt-5.4'");
    expect(exec.calls[0]?.cmd).not.toContain('copilot-pinned');
  });

  it('returns usage only from reported token counts and never a cost', async () => {
    const withUsage = await new CopilotCliHarness(recordingExec(SUCCESS), quiet).run(request());
    expect(withUsage.usage).toEqual({ inputTokens: 150, outputTokens: 30, numTurns: 2, cacheReadTokens: 40 });
    const noUsage = await new CopilotCliHarness(recordingExec(transcript(message('ok'))), quiet).run(request());
    expect(noUsage.usage).toBeUndefined();
  });

  it('keeps an ESCALATE: line in the final message byte for byte and drops one from an earlier message', async () => {
    const final = '  Investigated.\nESCALATE: needs-info: which API version?\n';
    const early = transcript(message('ESCALATE: needs-info: early'), message(final));
    expect((await new CopilotCliHarness(recordingExec(early), quiet).run(request())).output).toBe(final);
    const late = transcript(message('ESCALATE: needs-info: early'), message('Done after all.'));
    expect((await new CopilotCliHarness(recordingExec(late), quiet).run(request())).output).toBe('Done after all.');
  });

  it('ignores sub-agent messages when picking the final message', async () => {
    const stdout = transcript(message('Top level.'), message('from a sub-agent', { parentToolCallId: 'tool-9' }));
    expect((await new CopilotCliHarness(recordingExec(stdout), quiet).run(request())).output).toBe('Top level.');
  });

  it('rejects an empty final message as empty_response', async () => {
    const err = await rejection(new CopilotCliHarness(recordingExec(transcript(message('  '))), quiet));
    expect(err.reason).toBe('empty_response');
    expect(err.message).toBe('copilot CLI returned an empty final message');
  });

  it('rejects non-JSON stdout as error, keeping the raw output', async () => {
    const err = await rejection(new CopilotCliHarness(recordingExec('plain text answer\n'), quiet));
    expect(err.reason).toBe('error');
    expect(err.details.stdout).toBe('plain text answer\n');
  });

  it('rejects a failed result record even when the process exited 0', async () => {
    const stdout = transcript(
      line({ type: 'session.error', data: { errorType: 'quota', message: 'Quota exceeded' } }),
      line({ type: 'result', exitCode: 1 }),
    );
    const err = await rejection(new CopilotCliHarness(recordingExec(stdout), quiet));
    expect(err.reason).toBe('usage_cap');
    expect(err.details.kind).toBe('usage_cap');
    expect(err.message).toContain('(exit 1)');
  });

  it('treats a session error followed by a final message and exit 0 as a recovered success', async () => {
    const stdout = transcript(
      line({ type: 'session.error', data: { message: 'transient', statusCode: 500 } }),
      message('Recovered.'),
      line({ type: 'result', exitCode: 0 }),
    );
    expect((await new CopilotCliHarness(recordingExec(stdout), quiet).run(request())).output).toBe('Recovered.');
  });

  it('names containment when a denied tool call leaves an empty final message and --allow-all was not passed', async () => {
    const stdout = transcript(
      line({
        type: 'tool.execution_complete',
        data: { success: false, error: { message: 'Permission denied and could not request permission from user' } },
      }),
      message(''),
    );
    const err = await rejection(new CopilotCliHarness(recordingExec(stdout), quiet));
    expect(err.reason).toBe('permission_denied');
    expect(err.message).toContain('sandbox.copilotAllowAll: true only inside an isolated runtime');
  });

  it('classifies a non-zero exit with a denied tool call as permission_denied', async () => {
    const stdout = transcript(
      line({
        type: 'tool.execution_complete',
        data: { success: false, error: 'Permission denied and could not request permission from user' },
      }),
    );
    const err = await rejection(new CopilotCliHarness(failingExec({ code: 1, stdout, stderr: '' }), quiet));
    expect(err.reason).toBe('permission_denied');
  });

  it('classifies a non-zero exit with an empty final message and no error as empty_response', async () => {
    const err = await rejection(
      new CopilotCliHarness(failingExec({ code: 1, stdout: transcript(message('')), stderr: '' }), quiet),
    );
    expect(err.reason).toBe('empty_response');
    expect(err.message).toBe('copilot CLI exited 1: empty final message');
  });

  it('maps a killed child to timeout and exit 127 to cli_missing', async () => {
    const killed = await rejection(new CopilotCliHarness(failingExec({ killed: true }), quiet));
    expect(killed.reason).toBe('timeout');
    expect(killed.message).toBe('copilot CLI was killed after 60s (timeout)');
    const missing = await rejection(
      new CopilotCliHarness(failingExec({ code: 127, stderr: 'sh: copilot: command not found' }), quiet),
    );
    expect(missing.reason).toBe('cli_missing');
  });

  it('reads the reason from a session.error status code on a failed exit', async () => {
    const stdout = transcript(
      line({ type: 'session.error', data: { errorType: 'api', message: 'Too Many Requests', statusCode: 429 } }),
    );
    const err = await rejection(new CopilotCliHarness(failingExec({ code: 1, stdout, stderr: '' }), quiet));
    expect(err.reason).toBe('rate_limit');
    expect(err.details.diagnostic).toBe('api: Too Many Requests (status 429)');
  });
});

describe('CopilotCliHarness.classifyError', () => {
  it('keeps the kind a HarnessError already carries', () => {
    const err = new HarnessError('x', 'local_auth', { kind: 'auth' });
    expect(new CopilotCliHarness(undefined, quiet).classifyError(err)).toMatchObject({
      reason: 'local_auth',
      kind: 'auth',
    });
  });

  it('classifies raw exec errors from their diagnostic text', () => {
    const failure = new CopilotCliHarness(undefined, quiet).classifyError({
      details: { stderr: 'Error: Access denied by policy settings', exitCode: 1 },
    });
    expect(failure).toMatchObject({ reason: 'local_auth', kind: 'auth' });
  });
});

describe('parseCopilotJson', () => {
  it('returns undefined when stdout has no JSON events', () => {
    expect(parseCopilotJson('not json\n{"no":"type"}\n')).toBeUndefined();
  });

  it('handles CRLF line endings', () => {
    expect(parseCopilotJson(`${message('crlf')}\r\n`)?.text).toBe('crlf');
  });
});
