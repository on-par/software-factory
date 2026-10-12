import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { diagnoseModels, ModelRegistry } from '../models/index.js';
import { codingHarnessContractCases, makeContractRequest } from './contract.js';
import { HarnessError } from './index.js';
import { OpenCodeHarness } from './opencode.js';

describe('CodingHarness contract: OpenCodeHarness', () => {
  const cases = codingHarnessContractCases({
    success: () => ({ harness: new OpenCodeHarness(async () => ({ stdout: 'opencode output', stderr: '' })) }),
    timeout: () => ({
      harness: new OpenCodeHarness(async () => {
        throw Object.assign(new Error('killed'), { killed: true });
      }),
    }),
    emptyOutput: () => ({ harness: new OpenCodeHarness(async () => ({ stdout: '   ', stderr: '' })) }),
    failure: () => ({
      harness: new OpenCodeHarness(async () => {
        throw Object.assign(new Error('boom'), { stderr: 'rate limit exceeded', code: 1 });
      }),
    }),
  });
  for (const contractCase of cases) it(contractCase.name, contractCase.run);
});

const modelsConfig: ModelsConfig = {
  version: 1,
  models: {
    'opencode-model': {
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
    'opencode-no-provider-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      harness: 'opencode',
    },
  },
  tiers: { boss: ['opencode-model', 'opencode-no-provider-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const registry = new ModelRegistry(modelsConfig);

function recordingExec(result: { stdout?: string; stderr?: string } = {}) {
  const calls: { cmd: string; opts: any; promptPath?: string; stdin?: string }[] = [];
  const fn = async (cmd: string, opts: any) => {
    const promptPath = /< '([^']+)'$/.exec(cmd)?.[1];
    calls.push({ cmd, opts, promptPath, stdin: promptPath ? readFileSync(promptPath, 'utf8') : undefined });
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { fn, calls };
}

describe('OpenCodeHarness command shape', () => {
  it('builds the expected invocation with a provider model', async () => {
    const rec = recordingExec({ stdout: 'OPENCODE OUTPUT' });
    const harness = new OpenCodeHarness(rec.fn);

    const result = await harness.run(
      makeContractRequest({
        model: 'opencode-model',
        registry,
        prompt: 'build it',
        worktree: '/tmp/factory worktree',
        timeoutSeconds: 7,
      }),
    );

    expect(result.output).toBe('OPENCODE OUTPUT');
    expect(rec.calls).toHaveLength(1);
    const { cmd, opts } = rec.calls[0];
    expect(cmd).toMatch(/^opencode run /);
    expect(cmd).toContain("--model 'anthropic/claude-sonnet-5'");
    expect(cmd).not.toContain('build it');
    expect(cmd).toMatch(/ < '[^']*factory-opencode-prompt-[^']*\/prompt\.txt'$/);
    expect(cmd).not.toContain('/dev/null');
    expect(rec.calls[0].stdin).toBe('build it');
    expect(opts.cwd).toBe('/tmp/factory worktree');
    expect(opts.timeoutMs).toBe(7 * 1000);
    expect(opts.maxBuffer).toBe(10 * 1024 * 1024);
  });

  it('omits the model flag when no providerModel is configured', async () => {
    const rec = recordingExec({ stdout: 'OPENCODE OUTPUT' });
    const harness = new OpenCodeHarness(rec.fn);

    await harness.run(makeContractRequest({ model: 'opencode-no-provider-model', registry, prompt: 'build it' }));

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].cmd).toMatch(/^opencode run /);
    expect(rec.calls[0].cmd).not.toContain('--model');
    expect(rec.calls[0].cmd).not.toContain('opencode-no-provider-model');
  });

  it('forwards request.env verbatim to the execFn opts', async () => {
    const rec = recordingExec({ stdout: 'OPENCODE OUTPUT' });
    const harness = new OpenCodeHarness(rec.fn);

    await harness.run(
      makeContractRequest({
        model: 'opencode-model',
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
    const rec = recordingExec({ stdout: 'OPENCODE OUTPUT' });
    const harness = new OpenCodeHarness(rec.fn);
    const onPgid = () => {};

    await harness.run(makeContractRequest({ model: 'opencode-model', registry, prompt: 'build it', onPgid }));

    expect(rec.calls[0].opts.onPgid).toBe(onPgid);
  });

  it('leaves opts.env undefined when the request has no env', async () => {
    const rec = recordingExec({ stdout: 'OPENCODE OUTPUT' });
    const harness = new OpenCodeHarness(rec.fn);

    await harness.run(makeContractRequest({ model: 'opencode-model', registry, prompt: 'build it' }));

    expect(rec.calls[0].opts.env).toBeUndefined();
  });
});

describe('OpenCodeHarness prompt file', () => {
  it('sends prompt + nudge on stdin for the retry after empty stdout', async () => {
    const rec = recordingExec({ stdout: '' });
    const harness = new OpenCodeHarness(rec.fn);

    await harness.run(makeContractRequest({ model: 'opencode-model', registry, prompt: 'build it' })).catch(() => {});

    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[1].stdin?.startsWith('build it')).toBe(true);
    expect(rec.calls[1].stdin).toContain('final message must contain your complete answer');
  });

  it('removes the prompt directory after success and after a throw', async () => {
    const ok = recordingExec({ stdout: 'out' });
    await new OpenCodeHarness(ok.fn).run(makeContractRequest({ model: 'opencode-model', registry, prompt: 'x' }));
    expect(existsSync(dirname(ok.calls[0].promptPath!))).toBe(false);

    let path: string | undefined;
    const failing = new OpenCodeHarness(async (cmd: string) => {
      path = /< '([^']+)'$/.exec(cmd)?.[1];
      throw Object.assign(new Error('boom'), { stderr: 'x', code: 1 });
    });
    await failing.run(makeContractRequest({ model: 'opencode-model', registry, prompt: 'x' })).catch(() => {});
    expect(path).toBeDefined();
    expect(existsSync(dirname(path!))).toBe(false);
  });
});

describe('OpenCodeHarness large prompt delivery', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'delivers a 300 KB prompt to a fake opencode binary on stdin, not argv',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'factory-opencode-test-'));
      dirs.push(root);
      const binDir = join(root, 'bin');
      const outDir = join(root, 'out');
      const work = join(root, 'work');
      for (const d of [binDir, outDir, work]) mkdirSync(d);
      const bin = join(binDir, 'opencode');
      writeFileSync(
        bin,
        '#!/bin/sh\ncat > "$FAKE_OPENCODE_OUT/stdin.txt"\nprintf \'%s\\n\' "$@" > "$FAKE_OPENCODE_OUT/argv.txt"\necho fake-ok\n',
      );
      chmodSync(bin, 0o755);

      const chunk = 'PROMPT-MARKER-2460 it\'s "q" $HOME `bt` back\\slash\n line\n';
      const prompt = chunk.repeat(Math.ceil((300 * 1024) / chunk.length)).slice(0, 300 * 1024);
      expect(Buffer.byteLength(prompt)).toBeGreaterThanOrEqual(300 * 1024);

      const result = await new OpenCodeHarness().run(
        makeContractRequest({
          model: 'opencode-model',
          registry,
          prompt,
          worktree: work,
          timeoutSeconds: 30,
          env: { PATH: `${binDir}:${process.env.PATH}`, FAKE_OPENCODE_OUT: outDir },
        }),
      );

      expect(result.output.trim()).toBe('fake-ok');
      expect(readFileSync(join(outDir, 'stdin.txt'), 'utf8')).toBe(prompt);
      const argv = readFileSync(join(outDir, 'argv.txt'), 'utf8');
      expect(argv).not.toContain('PROMPT-MARKER-2460');
      expect(argv.length).toBeLessThan(1024);
    },
  );
});

describe('OpenCodeHarness failure classification', () => {
  it('classifies usage_cap from stderr', async () => {
    const harness = new OpenCodeHarness(async () => {
      throw Object.assign(new Error('boom'), { stderr: 'quota exceeded', code: 1 });
    });

    const err: any = await harness.run(makeContractRequest({ model: 'opencode-model', registry })).catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('usage_cap');
    expect(err.details.stderr).toBe('quota exceeded');
  });

  it('classifies killed exec as timeout', async () => {
    const harness = new OpenCodeHarness(async () => {
      throw Object.assign(new Error('killed'), { killed: true });
    });

    const err: any = await harness.run(makeContractRequest({ model: 'opencode-model', registry })).catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('timeout');
  });
});

describe('OpenCode doctor auth probe', () => {
  const def = {
    provider: 'custom' as const,
    tier: 'worker' as const,
    costPerMtokInput: 0,
    costPerMtokOutput: 0,
    contextWindow: 1000,
    capabilities: [],
    harness: 'opencode',
    providerModel: 'opencode-go/deepseek-v4-flash',
  };
  const doctorConfig: ModelsConfig = {
    ...modelsConfig,
    models: {
      'keyed-model': { ...def, envKey: 'OPENCODE_API_KEY' },
      'keyed-model-2': { ...def, envKey: 'OPENCODE_API_KEY' },
      'keyless-model': { ...def, envKey: null },
    },
  };
  const doctorRegistry = new ModelRegistry(doctorConfig);
  // Single-model registry so a probe-call assertion only sees the model under test.
  const diagnose = (id: string, probes: Parameters<typeof diagnoseModels>[1]) =>
    diagnoseModels(new ModelRegistry({ ...doctorConfig, models: { [id]: doctorConfig.models[id] } }), probes, true)[0];
  const hasOpencode = (cmd: string) => cmd === 'opencode';

  it('reports an OPENCODE_API_KEY model reachable when opencode is logged in and the key is unset', () => {
    const d = diagnose('keyed-model', {
      commandAvailable: hasOpencode,
      envPresent: () => false,
      opencodeLoggedIn: () => true,
    });
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (opencode CLI auth; OPENCODE_API_KEY not set)');
  });

  it('reports an OPENCODE_API_KEY model reachable via the key override when opencode is not logged in, without consulting the login probe', () => {
    const opencodeLoggedIn = vi.fn(() => false);
    const d = diagnose('keyed-model', {
      commandAvailable: hasOpencode,
      envPresent: (k) => k === 'OPENCODE_API_KEY',
      opencodeLoggedIn,
    });
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (opencode CLI)');
    expect(opencodeLoggedIn).not.toHaveBeenCalled();
  });

  it('marks the model unverified when neither logged in nor keyed', () => {
    const d = diagnose('keyed-model', {
      commandAvailable: hasOpencode,
      envPresent: () => false,
      opencodeLoggedIn: () => false,
    });
    expect(d.reachable).toBe(false);
    expect(d.unverified).toBe(true);
    expect(d.reason).toContain('opencode auth login');
    expect(d.reason).toContain('OPENCODE_API_KEY');
  });

  it('keeps an envKey-less model reachable without consulting the login probe', () => {
    const opencodeLoggedIn = vi.fn(() => false);
    const d = diagnose('keyless-model', { commandAvailable: hasOpencode, envPresent: () => false, opencodeLoggedIn });
    expect(d.reachable).toBe(true);
    expect(d.reason).toBe('ok (opencode CLI)');
    expect(opencodeLoggedIn).not.toHaveBeenCalled();
  });

  it('reports a missing opencode CLI without consulting the login probe', () => {
    const opencodeLoggedIn = vi.fn(() => true);
    const d = diagnose('keyed-model', { commandAvailable: () => false, envPresent: () => false, opencodeLoggedIn });
    expect(d.reachable).toBe(false);
    expect(d.reason).toBe('opencode CLI not found on PATH');
    expect(opencodeLoggedIn).not.toHaveBeenCalled();
  });

  it('treats a throwing login probe as not logged in and probes at most once', () => {
    const opencodeLoggedIn = vi.fn((): boolean => {
      throw new Error('boom');
    });
    const diags = diagnoseModels(
      doctorRegistry,
      { commandAvailable: hasOpencode, envPresent: () => false, opencodeLoggedIn },
      true,
    ).filter((d) => d.model.startsWith('keyed-model'));
    expect(diags).toHaveLength(2);
    for (const d of diags) expect(d.unverified).toBe(true);
    expect(opencodeLoggedIn).toHaveBeenCalledTimes(1);
  });
});
