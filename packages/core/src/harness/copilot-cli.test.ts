import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

const FIXTURES = new URL('../__fixtures__/copilot-cli/', import.meta.url);
const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`copilot-cli-synthetic-1.0.114.${name}.jsonl`, FIXTURES)), 'utf8');

function withoutEvent(stdout: string, type: string): string {
  const kept = stdout.split('\n').filter((l) => !l.includes(`"type":"${type}"`));
  return kept.join('\n');
}

const line = (event: Record<string, unknown>) => JSON.stringify(event);
const message = (content: string, extra: Record<string, unknown> = {}) =>
  line({ type: 'assistant.message', data: { messageId: 'msg-0001', content, toolRequests: [], ...extra } });
const transcript = (...lines: string[]) => `${lines.join('\n')}\n`;

const SUCCESS = fixture('success');
const SUCCESS_OUTPUT = 'Added a unit test for the parser and ran it.';
const NO_ALLOW_ALL_LINE =
  'copilot: no --allow-all for task build_copilot (the OS sandbox is off); tool calls that need approval are denied';

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

  it.each([
    ['without --allow-all', { allowAll: false, promptPath: '/tmp/p.txt' }],
    ['with --allow-all and a model', { allowAll: true, providerModel: 'gpt-5.4', promptPath: '/tmp/p.txt' }],
  ])(
    'never passes --trust-folder %s, so repository hooks, workspace MCP servers and plugin settings stay unloaded',
    (_label, opts) => {
      expect(buildCopilotCommand(opts)).not.toContain('--trust-folder');
    },
  );
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
    expect(result.output).toBe(SUCCESS_OUTPUT);
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

  it('sums token counts from every assistant.usage event, sub-agent included, and never a cost (synthetic 1.0.114 fixture)', async () => {
    const result = await new CopilotCliHarness(recordingExec(SUCCESS), quiet).run(request());
    expect(result.usage).toEqual({ inputTokens: 3000, outputTokens: 240, numTurns: 3, cacheReadTokens: 1400 });
  });

  it('returns no usage when the run has no assistant.usage event, ignoring the result record usage (synthetic 1.0.114 fixture)', async () => {
    const result = await new CopilotCliHarness(recordingExec(fixture('escalate-final')), quiet).run(request());
    expect(result.usage).toBeUndefined();
  });

  it('returns the final top-level message verbatim with its ESCALATE: line byte for byte (synthetic 1.0.114 fixture)', async () => {
    const result = await new CopilotCliHarness(recordingExec(fixture('escalate-final')), quiet).run(request());
    expect(result.output).toBe(
      '  Investigated the client.\nESCALATE: needs-info: which API version should the client target?\n',
    );
  });

  it('drops an ESCALATE: line that only an earlier message carried (synthetic 1.0.114 fixture)', async () => {
    const result = await new CopilotCliHarness(recordingExec(fixture('escalate-earlier')), quiet).run(request());
    expect(result.output).toBe('Updated the client to API version 2.');
  });

  it('never takes a sub-agent message as the final message (synthetic 1.0.114 fixture)', () => {
    const lines = SUCCESS.split('\n');
    const throughSubAgent = lines.slice(
      0,
      lines.findIndex((l) => l.includes('"type":"subagent.completed"')),
    );
    expect(throughSubAgent.join('\n')).toContain('Sub-agent note');
    expect(parseCopilotJson(throughSubAgent.join('\n'))?.text).toBe('');
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

  it('rejects a failed result record even when the process exited 0 (synthetic 1.0.114 fixture)', async () => {
    const err = await rejection(new CopilotCliHarness(recordingExec(fixture('error-allowance')), quiet));
    expect(err.reason).toBe('usage_cap');
    expect(err.details.kind).toBe('usage_cap');
    expect(err.message).toBe(
      'copilot CLI reported a failed run (exit 1): the Copilot premium request allowance is used up',
    );
  });

  it('treats a session error followed by a final message and exit 0 as a recovered success', async () => {
    const stdout = transcript(
      line({ type: 'session.error', data: { errorType: 'query', message: 'transient', statusCode: 500 } }),
      message('Recovered.'),
      line({ type: 'result', exitCode: 0 }),
    );
    expect((await new CopilotCliHarness(recordingExec(stdout), quiet).run(request())).output).toBe('Recovered.');
  });

  it('keeps the result of a run whose denied tool call was followed by a final message and exit 0, and logs the denial once (synthetic 1.0.114 fixture)', async () => {
    const lines: string[] = [];
    const harness = new CopilotCliHarness(recordingExec(fixture('denied-recovered')), { log: (l) => lines.push(l) });
    const result = await harness.run(request());
    expect(result.output).toBe(
      'The shell command was denied, so I reviewed the tests by reading them. The fix is in place.',
    );
    expect(lines).toEqual([
      NO_ALLOW_ALL_LINE,
      'copilot: 1 tool call was denied without containment for task build_copilot; the final message stands and CHECK judges the work',
    ]);
  });

  it('logs no denial when --allow-all was passed (synthetic 1.0.114 fixture)', async () => {
    const lines: string[] = [];
    const harness = new CopilotCliHarness(recordingExec(fixture('denied-recovered')), { log: (l) => lines.push(l) });
    await harness.run(request({ copilotAllowAll: true }));
    expect(lines).toEqual(['copilot: --allow-all for task build_copilot (sandbox.copilotAllowAll: true in config)']);
  });

  it.each([
    ['the process exited 0 and the result record says 1', recordingExec(fixture('denied-empty'))],
    ['the process exited 1', failingExec({ code: 1, stdout: fixture('denied-empty'), stderr: '' })],
  ])(
    'names containment when a denied tool call leaves an empty final message and %s (synthetic 1.0.114 fixture)',
    async (_label, exec) => {
      const err = await rejection(new CopilotCliHarness(exec, quiet));
      expect(err.reason).toBe('permission_denied');
      expect(err.details.kind).toBe('other');
      expect(err.message).toContain('sandbox.copilotAllowAll: true only inside an isolated runtime');
    },
  );

  it.each([
    ['permission.completed with the documented denied kind alone', 'tool.execution_complete'],
    ['the tool error alone', 'permission.completed'],
  ])('detects a denied tool call from %s (synthetic 1.0.114 fixture)', async (_label, dropped) => {
    const stdout = withoutEvent(fixture('denied-empty'), dropped);
    expect(parseCopilotJson(stdout)?.deniedTools).toBe(1);
    expect((await rejection(new CopilotCliHarness(recordingExec(stdout), quiet))).reason).toBe('permission_denied');
  });

  it('does not count a permission that was approved or denied by a rule as unapprovable', () => {
    const completed = (kind: string, toolCallId: string) =>
      line({ type: 'permission.completed', data: { requestId: toolCallId, toolCallId, result: { kind } } });
    const stdout = transcript(completed('approved', 'call-0001'), completed('denied-by-rules', 'call-0002'));
    expect(parseCopilotJson(stdout)?.deniedTools).toBe(0);
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

  it.each([
    ['a rejected token', 'error-token-rejected', 'local_auth', 'auth', 'authentication: Authentication failed'],
    [
      'a used-up allowance (pattern documented-only)',
      'error-allowance',
      'usage_cap',
      'usage_cap',
      'quota: The premium request allowance for this account is used up. (status 402)',
    ],
    [
      'a 429 (pattern documented-only)',
      'error-rate-limit',
      'rate_limit',
      'rate_limit',
      'rate_limit: Request was throttled. Try again later. (code rate_limited, status 429)',
    ],
  ])(
    'reads the reason for %s from session.error on a failed exit (synthetic 1.0.114 fixture)',
    async (_label, name, reason, kind, diagnostic) => {
      const stdout = fixture(name);
      const err = await rejection(new CopilotCliHarness(failingExec({ code: 1, stdout, stderr: '' }), quiet));
      expect(err.reason).toBe(reason);
      expect(err.details.kind).toBe(kind);
      expect(err.details.diagnostic).toBe(diagnostic);
    },
  );
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

  it('ignores the fixture note, session.idle and other unknown event types (synthetic 1.0.114 fixture)', () => {
    const [note = ''] = SUCCESS.split('\n');
    const idle = line({ type: 'session.idle', data: {}, ephemeral: true });
    expect(parseCopilotJson(transcript(note, idle))).toEqual({ text: '', errorText: '', deniedTools: 0 });
  });

  it.each([
    ['at the top level', { type: 'result', exitCode: 3 }],
    ['under data', { type: 'result', data: { exitCode: 3 } }],
  ])('reads a numeric result exit code %s', (_label, record) => {
    expect(parseCopilotJson(transcript(line(record)))?.exitCode).toBe(3);
  });

  it('skips a sub-agent message in the older shape that carried data.parentToolCallId', () => {
    const stdout = transcript(message('Top level.'), message('from a sub-agent', { parentToolCallId: 'call-0009' }));
    expect(parseCopilotJson(stdout)?.text).toBe('Top level.');
  });
});
