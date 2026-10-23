import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { HarnessDeclaration, ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import { CliModelExecutor } from '../router/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { wrapCommandInSandbox } from '../sandbox/index.js';
import { shellEscape } from '../utils/index.js';
import {
  buildHarnessCommand,
  CommandHarness,
  extractJsonlLastMessage,
  matchErrorPattern,
  matchErrorPatternFailure,
  parseJsonlUsage,
} from './command.js';
import { codingHarnessContractCases, makeContractRequest } from './contract.js';
import { HarnessError } from './index.js';

const realExec = it.skipIf(process.platform === 'win32');
const tmpDirs: string[] = [];
function tmp(prefix = 'cmd-harness-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function declare(over: Partial<HarnessDeclaration> = {}): HarnessDeclaration {
  return { command: 'agent {model}', prompt: 'stdin', output: 'stdout', agentic: true, usage: 'none', ...over };
}

function makeRegistry(harnesses: Record<string, HarnessDeclaration>, providerModel?: string): ModelRegistry {
  const config: ModelsConfig = {
    version: 1,
    models: {
      fake: {
        provider: 'custom',
        tier: 'boss',
        costPerMtokInput: 0,
        costPerMtokOutput: 0,
        contextWindow: 1000,
        capabilities: [],
        envKey: null,
        codex: true,
        harness: Object.keys(harnesses)[0],
        ...(providerModel ? { providerModel } : {}),
      },
    },
    tiers: { boss: ['fake'] },
    failover: {
      triggers: ['rate_limit', 'unavailable', 'auth'],
      maxRetries: 2,
      cooldownMs: 0,
    },
    routingRules: {},
    harnesses,
  };
  return new ModelRegistry(config);
}

function writeAgent(dir: string, body: string): string {
  const path = join(dir, 'agent.sh');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('CodingHarness contract: CommandHarness', () => {
  const make = (execFn: any) => new CommandHarness('my-agent', declare(), execFn);
  const cases = codingHarnessContractCases({
    success: () => ({ harness: make(async () => ({ stdout: 'agent output', stderr: '' })) }),
    timeout: () => ({
      harness: make(async () => {
        throw Object.assign(new Error('killed'), { killed: true });
      }),
    }),
    emptyOutput: () => ({ harness: make(async () => ({ stdout: '  ', stderr: '' })) }),
    failure: () => ({
      harness: make(async () => {
        throw Object.assign(new Error('boom'), { stderr: 'rate limit exceeded', code: 1 });
      }),
    }),
  });
  for (const contractCase of cases) it(contractCase.name, contractCase.run);
});

describe('CodingHarness contract: CommandHarness with errorPatterns and jsonl usage', () => {
  const make = (execFn: any) =>
    new CommandHarness('my-agent', declare({ usage: 'jsonl', errorPatterns: { rate_limit: 'slow down' } }), execFn);
  const cases = codingHarnessContractCases({
    success: () => ({
      harness: make(async () => ({
        stdout: '{"text":"ok","usage":{"input_tokens":3,"output_tokens":4}}',
        stderr: '',
      })),
    }),
    timeout: () => ({
      harness: make(async () => {
        throw Object.assign(new Error('killed'), { killed: true, stderr: 'slow down' });
      }),
    }),
    emptyOutput: () => ({ harness: make(async () => ({ stdout: '  ', stderr: '' })) }),
    failure: () => ({
      harness: make(async () => {
        throw Object.assign(new Error('boom'), { stderr: 'slow down', code: 1 });
      }),
    }),
  });
  for (const contractCase of cases) it(contractCase.name, contractCase.run);
});

describe('CommandHarness errorPatterns and usage', () => {
  const request = () => makeContractRequest();
  const failing = (over: Record<string, unknown>) => async () => {
    throw Object.assign(new Error('boom'), { code: 1, ...over });
  };
  const reasonOf = async (decl: Partial<HarnessDeclaration>, execFn: any): Promise<string | undefined> => {
    try {
      await new CommandHarness('my-agent', declare(decl), execFn).run(request());
    } catch (err) {
      return (err as HarnessError).reason;
    }
    return undefined;
  };

  it('errorPatterns selects the record key as the reason from stderr or stdout', async () => {
    const patterns = { rate_limit: 'slow down' };
    expect(await reasonOf({ errorPatterns: patterns }, failing({ stderr: 'HTTP 503 slow down' }))).toBe('rate_limit');
    expect(await reasonOf({}, failing({ stderr: 'HTTP 503 slow down' }))).toBe('unknown');
    expect(await reasonOf({ errorPatterns: patterns }, failing({ stderr: '', stdout: 'x SLOW DOWN x' }))).toBe(
      'rate_limit',
    );
    expect(
      await reasonOf({ errorPatterns: { usage_cap: 'both', rate_limit: 'both' } }, failing({ stderr: 'both' })),
    ).toBe('usage_cap');
    expect(await reasonOf({ errorPatterns: patterns }, failing({ stderr: 'rate limit exceeded' }))).toBe('rate_limit');
    expect(await reasonOf({ errorPatterns: patterns }, failing({ stderr: 'plain failure' }))).toBe('error');
    const ok = async () => ({ stdout: 'slow down but fine', stderr: '' });
    expect(await reasonOf({ errorPatterns: patterns }, ok)).toBeUndefined();
  });

  it('array-form errorPatterns classify the matched text', async () => {
    expect(await reasonOf({ errorPatterns: ['rate limit'] }, failing({ stderr: '', stdout: 'rate limit hit' }))).toBe(
      'rate_limit',
    );
    expect(await reasonOf({ errorPatterns: ['boom'] }, failing({ stderr: 'boom' }))).toBe('error');
  });

  it('usage jsonl returns summed input/output tokens; usage none returns no usage', async () => {
    const stdout = [
      '{"text":"hello","input_tokens":1,"output_tokens":2}',
      'not json',
      '{"type":"noise"}',
      '{"usage":{"input_tokens":10,"output_tokens":20}}',
    ].join('\n');
    const exec = async () => ({ stdout, stderr: '' });
    const withUsage = await new CommandHarness('a', declare({ usage: 'jsonl' }), exec).run(request());
    expect(withUsage.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
    const without = await new CommandHarness('a', declare({ usage: 'none' }), exec).run(request());
    expect(without.usage).toBeUndefined();
    expect('usage' in without).toBe(false);
    const noTokens = await new CommandHarness('a', declare({ usage: 'jsonl' }), async () => ({
      stdout: 'plain text',
      stderr: '',
    })).run(request());
    expect(noTokens.usage).toBeUndefined();
  });
});

describe('parseJsonlUsage', () => {
  it('ignores non-finite, string and half-present counts', () => {
    expect(parseJsonlUsage('{"input_tokens":"1","output_tokens":2}')).toBeUndefined();
    expect(parseJsonlUsage('{"input_tokens":1e999,"output_tokens":2}')).toBeUndefined();
    expect(parseJsonlUsage('{"input_tokens":1}')).toBeUndefined();
    expect(parseJsonlUsage('[1,2]\n')).toBeUndefined();
    expect(parseJsonlUsage('')).toBeUndefined();
  });
});

describe('matchErrorPattern', () => {
  it('returns undefined without patterns, with empty patterns, and for non-string output', () => {
    expect(matchErrorPattern(undefined, 'a', 'b')).toBeUndefined();
    expect(matchErrorPattern({}, 'a', 'b')).toBeUndefined();
    expect(matchErrorPattern([], 'a', 'b')).toBeUndefined();
    expect(matchErrorPattern({ error: 'a' }, undefined as any, undefined as any)).toBeUndefined();
  });
});

describe('matchErrorPatternFailure', () => {
  const patterns = { usage_cap: 'limit reached, resets at (?<reset>\\S+)' };

  it('turns a named reset group into resetAt', () => {
    expect(matchErrorPatternFailure(patterns, 'limit reached, resets at 2026-11-01T00:00:00Z', '')).toEqual({
      reason: 'usage_cap',
      resetAt: '2026-11-01T00:00:00.000Z',
    });
    expect(
      matchErrorPatternFailure(
        ['limit reached, resets at (?<reset>\\S+)'],
        '',
        'limit reached, resets at 2026-11-01T00:00:00Z',
      ),
    ).toMatchObject({
      resetAt: '2026-11-01T00:00:00.000Z',
    });
  });

  it('omits resetAt when the capture is not a date or there is no reset group', () => {
    expect(matchErrorPatternFailure(patterns, 'limit reached, resets at soon', '')).toEqual({ reason: 'usage_cap' });
    expect(matchErrorPatternFailure({ error: 'boom' }, 'boom', '')).toEqual({ reason: 'error' });
    expect(matchErrorPattern(patterns, 'limit reached, resets at soon', '')).toBe('usage_cap');
  });

  it('CommandHarness puts kind and resetAt on the HarnessError details', async () => {
    const harness = new CommandHarness('my-agent', declare({ errorPatterns: patterns }), async () => {
      throw Object.assign(new Error('boom'), { code: 1, stderr: 'limit reached, resets at 2026-11-01T00:00:00Z' });
    });
    const err: any = await harness.run(makeContractRequest()).catch((e) => e);
    expect(err.details).toMatchObject({ kind: 'usage_cap', resetAt: '2026-11-01T00:00:00.000Z' });
  });
});

describe('buildHarnessCommand', () => {
  const values = { model: 'm 1', worktree: '/w t', outFile: '/o' };

  it('replaces each placeholder with its shell-escaped value', () => {
    expect(buildHarnessCommand('a {model} {worktree} {outFile}', values)).toBe(
      `a ${shellEscape('m 1')} ${shellEscape('/w t')} ${shellEscape('/o')}`,
    );
  });

  it('leaves unknown placeholders and a valueless {outFile} literal', () => {
    expect(buildHarnessCommand('{foo} {outFile}', { model: 'm', worktree: 'w' })).toBe('{foo} {outFile}');
  });

  it('does not re-substitute placeholder text inside a value', () => {
    expect(buildHarnessCommand('{model}', { model: '{worktree}', worktree: 'w' })).toBe(shellEscape('{worktree}'));
  });

  it("escapes single quotes as '\\''", () => {
    expect(buildHarnessCommand('{model}', { model: "a'b", worktree: 'w' })).toContain("'\\''");
  });
});

describe('extractJsonlLastMessage', () => {
  it('returns the last message-bearing object, skipping noise', () => {
    const out = ['{"type":"x"}', '{"text":"first"}', '{"item":{"text":"second"}}', 'not json', '', '[1]'].join('\n');
    expect(extractJsonlLastMessage(out)).toBe('second');
  });

  it('joins text parts of message.content arrays', () => {
    const line = JSON.stringify({
      message: { content: [{ type: 'text', text: 'a' }, { type: 'tool' }, { type: 'text', text: 'b' }] },
    });
    expect(extractJsonlLastMessage(line)).toBe('a\nb');
  });

  it('returns empty when nothing carries a message', () => {
    expect(extractJsonlLastMessage('{"type":"x"}\nplain')).toBe('');
  });
});

describe('CommandHarness real exec', () => {
  realExec('keeps shell metacharacters in {model} and {worktree} literal and runs no extra command', async () => {
    const root = tmp();
    const agent = writeAgent(root, 'for a in "$@"; do printf "%s\\n" "$a"; done > "$PWD/args.txt"; echo done');
    const evilModel = "x; touch pwned1 $(touch pwned2) `touch pwned3` '\\''q";
    const worktree = join(root, 'wt a;b');
    mkdirSync(worktree);
    const registry = makeRegistry(
      { evil: declare({ command: `${agent} --model {model} --cd {worktree}` }) },
      evilModel,
    );
    const harness = new CommandHarness('evil', registry.getHarnessDeclaration('evil')!);
    const result = await harness.run(makeContractRequest({ registry, model: 'fake', worktree, prompt: 'p' }));

    expect(result.output.trim()).toBe('done');
    expect(readFileSync(join(worktree, 'args.txt'), 'utf8')).toBe(`--model\n${evilModel}\n--cd\n${worktree}\n`);
    for (const dir of [worktree, process.cwd(), root]) {
      for (const name of ['pwned1', 'pwned2', 'pwned3']) expect(existsSync(join(dir, name))).toBe(false);
    }
  });

  const promptModes = ['stdin', 'file', 'arg'] as const;
  const outputModes = ['stdout', 'file:{outFile}', 'jsonl-last-message'] as const;
  const prompt = `say "hi" it's $HOME \`x\``;
  const combos = promptModes.flatMap((p) => outputModes.map((o) => [p, o] as const));

  realExec.each(combos)(
    'delivers the prompt and returns the expected text for prompt mode %s / output mode %s',
    async (promptMode, outputMode) => {
      const root = tmp();
      const read =
        promptMode === 'stdin'
          ? 'P=$(cat)'
          : promptMode === 'file'
            ? 'for a; do L=$a; done; P=$(cat "$L")'
            : 'for a; do P=$a; done';
      const emit =
        outputMode === 'stdout'
          ? 'printf "ECHO:%s" "$P"'
          : outputMode === 'file:{outFile}'
            ? 'printf "ECHO:%s" "$P" > "$OUT"'
            : 'echo \'{"type":"progress","text":"noise"}\'; printf \'{"type":"message","text":"ECHO:%s"}\\n\' "$(printf %s "$P" | sed \'s/\\\\/\\\\\\\\/g; s/"/\\\\"/g\')"; echo trailing';
      const agent = writeAgent(root, `${outputMode === 'file:{outFile}' ? 'OUT=$1; shift' : ':'}\n${read}\n${emit}`);
      const command = outputMode === 'file:{outFile}' ? `${agent} {outFile}` : agent;
      const registry = makeRegistry({ a: declare({ command, prompt: promptMode, output: outputMode }) });
      const harness = new CommandHarness('a', registry.getHarnessDeclaration('a')!);
      const result = await harness.run(makeContractRequest({ registry, model: 'fake', worktree: root, prompt }));
      expect(result.output).toContain(`ECHO:${prompt}`);
    },
  );

  realExec('rejects empty_response on empty stdout', async () => {
    const root = tmp();
    const registry = makeRegistry({ a: declare({ command: writeAgent(root, 'true') }) });
    const harness = new CommandHarness('a', registry.getHarnessDeclaration('a')!);
    await expect(harness.run(makeContractRequest({ registry, model: 'fake', worktree: root }))).rejects.toMatchObject({
      reason: 'empty_response',
    });
  });
});

describe('CommandHarness lifecycle', () => {
  const modes: HarnessDeclaration['prompt'][] = ['stdin', 'file', 'arg'];

  it.each(modes)('removes its temp files after success and failure (prompt %s)', async (promptMode) => {
    const seen: string[] = [];
    for (const fail of [false, true]) {
      const registry = makeRegistry({
        a: declare({ prompt: promptMode, output: 'file:{outFile}', command: 'agent {outFile}' }),
      });
      const harness = new CommandHarness('a', registry.getHarnessDeclaration('a')!, async (cmd) => {
        const path = /'([^']*factory-command-[^']*)'/.exec(cmd)![1];
        seen.push(path);
        expect(existsSync(path)).toBe(true);
        if (fail) throw new Error('boom');
        return { stdout: '', stderr: '' };
      });
      await harness.run(makeContractRequest({ registry, model: 'fake' })).catch((err) => {
        expect(err).toBeInstanceOf(HarnessError);
      });
    }
    expect(seen).toHaveLength(2);
    for (const path of seen) expect(existsSync(path)).toBe(false);
  });
});

describe('CommandHarness BUILD through CliModelExecutor', () => {
  realExec(
    'fake agent completes a BUILD through CliModelExecutor, commits locally, pushes nothing, returns the summary',
    async () => {
      const root = tmp();
      const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
      const remote = join(root, 'remote.git');
      const worktree = join(root, 'wt');
      mkdirSync(worktree);
      git(root, 'init', '--bare', remote);
      git(worktree, 'init', '-b', 'main');
      writeFileSync(join(worktree, 'README.md'), 'hi\n');
      git(worktree, 'add', '.');
      git(worktree, '-c', 'user.name=f', '-c', 'user.email=f@x', 'commit', '-m', 'init');
      git(worktree, 'remote', 'add', 'origin', remote);
      git(worktree, 'push', 'origin', 'HEAD:main');
      const before = git(worktree, 'ls-remote', 'origin');

      const agent = writeAgent(
        root,
        'cd "$1" && echo feature > feature.txt && git add feature.txt && git -c user.name=f -c user.email=f@x commit -q -m feat && echo "Summary: added feature.txt"',
      );
      const registry = makeRegistry({
        'fake-agent': declare({ command: `${agent} {worktree}`, prompt: 'stdin', output: 'stdout', agentic: true }),
      });
      const routesConfig: RoutesConfig = {
        version: 1,
        routes: { build_codex: { tier: 'boss', description: 'stub', requires: 'codex' } },
      };
      const out = await new CliModelExecutor().runModel('fake', 'build it', {
        worktree,
        timeoutSeconds: 30,
        task: 'build_codex',
        registry,
        routesConfig,
      });

      expect(out.trim()).toBe('Summary: added feature.txt');
      expect(git(worktree, 'log', '-1', '--format=%s').trim()).toBe('feat');
      expect(git(worktree, 'ls-remote', 'origin')).toBe(before);
    },
  );
});

describe('CommandHarness sandbox', () => {
  const sandboxPolicy: SandboxPolicy = {
    runtime: 'sandbox-exec',
    worktree: '/tmp/factory worktree',
    writablePaths: ['/tmp/factory worktree'],
    writableFilePrefixes: [],
    allowHosts: [],
    cpuMs: 300_000,
    memMb: 4096,
  };
  const providerModel = "prov model; $(x) '";
  const prompt = 'do it';

  async function capture(sandbox?: SandboxPolicy): Promise<string> {
    const calls: string[] = [];
    const registry = makeRegistry({ a: declare({ command: 'agent {model}', prompt: 'arg' }) }, providerModel);
    const harness = new CommandHarness('a', registry.getHarnessDeclaration('a')!, async (cmd) => {
      calls.push(cmd);
      return { stdout: 'ok', stderr: '' };
    });
    await harness.run(makeContractRequest({ registry, model: 'fake', prompt, sandbox }));
    expect(calls).toHaveLength(1);
    return calls[0];
  }

  it('wraps the built command in the sandbox wrapper when request.sandbox is set', async () => {
    const raw = await capture();
    const wrapped = await capture(sandboxPolicy);
    expect(wrapped.startsWith('sandbox-exec -p ')).toBe(true);
    expect(wrapped).toBe(wrapCommandInSandbox(raw, sandboxPolicy));
  });

  it('runs the built command unwrapped when request.sandbox is undefined', async () => {
    const cmd = await capture();
    expect(cmd).toBe(`agent ${shellEscape(providerModel)} ${shellEscape(prompt)} < /dev/null`);
    expect(cmd).not.toContain('sandbox-exec');
    expect(cmd).not.toContain('/bin/sh -c');
  });

  it.each(['none', 'docker-sandbox'] as const)('leaves the command unwrapped for runtime %s', async (runtime) => {
    expect(await capture({ ...sandboxPolicy, runtime })).toBe(await capture());
  });

  realExec('keeps shell metacharacters literal through the sandbox wrapper', async () => {
    const root = tmp();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const shim = join(bin, 'sandbox-exec');
    writeFileSync(shim, '#!/bin/sh\ntouch "$SHIM_MARK"; shift 2; exec "$@"\n');
    chmodSync(shim, 0o755);
    const agent = writeAgent(root, 'for a in "$@"; do printf "%s\\n" "$a"; done > "$PWD/args.txt"; echo done');
    const evilModel = "x; touch pwned1 $(touch pwned2) `touch pwned3` '\\''q";
    const evilPrompt = "say $HOME `touch pwned4` it's";
    const worktree = join(root, 'wt a;b');
    mkdirSync(worktree);
    const registry = makeRegistry(
      { evil: declare({ command: `${agent} --model {model} --cd {worktree}`, prompt: 'arg' }) },
      evilModel,
    );
    const harness = new CommandHarness('evil', registry.getHarnessDeclaration('evil')!);
    const result = await harness.run(
      makeContractRequest({
        registry,
        model: 'fake',
        worktree,
        prompt: evilPrompt,
        sandbox: sandboxPolicy,
        env: { PATH: `${bin}:${process.env.PATH}`, SHIM_MARK: join(root, 'shim-ran') },
      }),
    );

    expect(existsSync(join(root, 'shim-ran'))).toBe(true);
    expect(result.output.trim()).toBe('done');
    expect(readFileSync(join(worktree, 'args.txt'), 'utf8')).toBe(
      `--model\n${evilModel}\n--cd\n${worktree}\n${evilPrompt}\n`,
    );
    for (const dir of [worktree, process.cwd(), root]) {
      for (const name of ['pwned1', 'pwned2', 'pwned3', 'pwned4']) expect(existsSync(join(dir, name))).toBe(false);
    }
  });
});
