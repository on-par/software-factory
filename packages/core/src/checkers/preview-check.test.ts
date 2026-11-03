import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { PreviewConfigSchema } from '../config/preview-section.js';
import type { CommandResult, RunCommandOptions } from '../utils/command-runner.js';
import {
  previewReworkSummary,
  runPreviewCheck,
  type PreviewCheckDeps,
  type PreviewCheckInput,
} from './preview-check.js';
import type { PinnedAddress } from './preview-pin.js';
import type { PreviewGitHub } from './preview-source.js';

const resolvesTo = (...answers: string[][]) => {
  const queue = [...answers];
  return async () => queue.shift() ?? [];
};

const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());

const SHA = 'a'.repeat(40);
const URL_WITH_TOKEN = 'https://p.example.com/?share=secret';

function previewAt(url: string | null): PreviewGitHub & { lookups: () => number } {
  let lookups = 0;
  return {
    lookups: () => lookups,
    listDeployments: async () => {
      lookups++;
      return url ? [{ id: 1, environment: 'preview/pr-7', createdAt: '2026-01-01T00:00:00Z' }] : [];
    },
    listDeploymentStatuses: async () =>
      url ? [{ state: 'success', createdAt: '2026-01-01T00:00:00Z', environmentUrl: url }] : [],
    listComments: async () => [],
    headCommitDate: async () => undefined,
  };
}

const okResult = (over: Partial<CommandResult> = {}): CommandResult => ({
  command: ['npm', 'run', 'smoke'],
  ok: true,
  exitCode: 0,
  stdout: '',
  stderr: '',
  killed: false,
  timedOut: false,
  ...over,
});

const config = (over: Record<string, unknown> = {}) =>
  PreviewConfigSchema.parse({
    source: { kind: 'deployment', environment: 'preview/pr-*' },
    command: ['npm', 'run', 'smoke'],
    readyTimeoutSeconds: 10,
    ...over,
  });

function setup(github: PreviewGitHub, over: Partial<PreviewCheckInput> = {}) {
  let clock = 0;
  const commands: { argv: readonly string[]; options: RunCommandOptions }[] = [];
  const probes: string[] = [];
  const pins: PinnedAddress[] = [];
  const input: PreviewCheckInput = {
    config: config(),
    github,
    owner: 'o',
    repo: 'r',
    prNumber: 7,
    headSha: SHA,
    worktree: tempDirs.makeSync('preview-'),
    ...over,
  };
  const deps = (more: Partial<PreviewCheckDeps> = {}): PreviewCheckDeps => ({
    probe: async (url, pin) => {
      probes.push(url);
      pins.push(pin);
      return 200;
    },
    resolveHost: async () => ['93.184.216.34'],
    runCommand: async (argv, options) => {
      commands.push({ argv, options });
      return okResult();
    },
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    now: () => clock,
    ...more,
  });
  return { input, deps, commands, probes, pins, advance: (ms: number) => (clock += ms) };
}

describe('runPreviewCheck', () => {
  it('runs the command with the real preview URL in PREVIEW_URL and records it masked', async () => {
    const h = setup(previewAt(URL_WITH_TOKEN), { env: { KEEP: '1' } });
    const r = await runPreviewCheck(h.input, h.deps());
    expect(r.status).toBe('pass');
    expect(h.commands[0]?.options.env).toEqual({ KEEP: '1', PREVIEW_URL: URL_WITH_TOKEN });
    expect(r.evidence.url).toBe('https://p.example.com/?***');
  });

  it('sets the configured urlEnv and polls the configured readyPath for expectedStatus', async () => {
    const h = setup(previewAt('https://p.example.com'), {
      config: config({ urlEnv: 'BASE', readyPath: '/healthz', expectedStatus: 204 }),
    });
    const r = await runPreviewCheck(h.input, h.deps({ probe: async (u) => (h.probes.push(u), 204) }));
    expect(r.status).toBe('pass');
    expect(h.probes).toEqual(['https://p.example.com/healthz']);
    expect(h.commands[0]?.options.env).toEqual({ BASE: 'https://p.example.com' });
  });

  it('waits until the preview answers, then reports the readiness wait and the command time separately', async () => {
    const h = setup(previewAt('https://p.example.com'));
    const answers: (number | null)[] = [null, 503, 200];
    const deps = h.deps({
      probe: async () => answers.shift() ?? null,
      runCommand: async () => {
        h.advance(1234);
        return okResult();
      },
    });
    const r = await runPreviewCheck(h.input, deps);
    expect(r.status).toBe('pass');
    expect(deps.sleep).toHaveBeenCalledTimes(2);
    expect(r.evidence).toMatchObject({ readyWaitMs: 10_000, commandMs: 1234, durationMs: 11_234 });
    expect(previewReworkSummary(r)).toContain('Ready wait: 10.0s; command: 1.2s');
  });

  it('reports fail with exit code, a tail of stdout and stderr, and copies artifacts into the run logs', async () => {
    const logsDir = tempDirs.makeSync('preview-logs-');
    const h = setup(previewAt('https://p.example.com'), {
      config: config({ artifacts: ['report', 'missing.txt'] }),
      logsDir,
    });
    mkdirSync(join(h.input.worktree, 'report'));
    writeFileSync(join(h.input.worktree, 'report/index.html'), '<html/>');
    const failed = okResult({ ok: false, exitCode: 2, stdout: '2 tests failed\n', stderr: '\u001b[31mboom\u001b[0m' });
    const r = await runPreviewCheck(h.input, h.deps({ runCommand: async () => failed }));
    expect(r.status).toBe('fail');
    expect(r.evidence).toMatchObject({
      headSha: SHA,
      command: ['npm', 'run', 'smoke'],
      exitCode: 2,
      outputTail: '2 tests failed\nboom',
      artifacts: ['report'],
      artifactsDir: join(logsDir, 'preview-artifacts'),
    });
    expect(readFileSync(join(logsDir, 'preview-artifacts/report/index.html'), 'utf8')).toBe('<html/>');
    expect(previewReworkSummary(r)).toContain('Exit code: 2');
  });

  it('records a command timeout as the reason', async () => {
    const h = setup(previewAt('https://p.example.com'), { config: config({ commandTimeoutSeconds: 30 }) });
    const timedOut = okResult({ ok: false, exitCode: 124, timedOut: true });
    const r = await runPreviewCheck(h.input, h.deps({ runCommand: async () => timedOut }));
    expect(r.evidence.reason).toBe('preview command timed out after 30s');
  });

  it('reports preview-unavailable when no URL is found before the timeout', async () => {
    const github = previewAt(null);
    const h = setup(github);
    const r = await runPreviewCheck(h.input, h.deps());
    expect(r.status).toBe('preview-unavailable');
    expect(r.evidence.reason).toBe(
      `no preview URL found for ${SHA.slice(0, 12)} (deployment environment preview/pr-*)`,
    );
    expect(github.lookups()).toBe(3);
    expect(h.commands).toEqual([]);
  });

  it('reports preview-unavailable with a masked URL when the preview never becomes ready', async () => {
    const h = setup(previewAt(URL_WITH_TOKEN));
    const r = await runPreviewCheck(h.input, h.deps({ probe: async () => 502 }));
    expect(r.status).toBe('preview-unavailable');
    expect(r.evidence.reason).toBe('preview https://p.example.com/?*** not ready (last status 502) after 10s');
    expect(r.evidence.url).toBe('https://p.example.com/?***');
  });

  it('retries a lookup error on every poll until the deadline and records it as the reason', async () => {
    let calls = 0;
    const failing: PreviewGitHub = {
      ...previewAt(null),
      listDeployments: async () => {
        calls++;
        throw new Error('api down');
      },
    };
    const h = setup(failing, { config: config({ readyTimeoutSeconds: 12 }) });
    const deps = h.deps();
    const r = await runPreviewCheck(h.input, deps);
    expect(r.evidence.reason).toBe('preview lookup failed: api down');
    expect(calls).toBe(4);
    expect(deps.sleep).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['a loopback URL', 'http://127.0.0.1:3000/', 'preview URL http://127.0.0.1:3000/ is not a public http(s) host'],
    [
      'a metadata URL',
      'http://169.254.169.254/?x=1',
      'preview URL http://169.254.169.254/?*** is not a public http(s) host',
    ],
  ])('refuses %s without probing or running the command', async (_name, url, reason) => {
    const h = setup(previewAt(url));
    const r = await runPreviewCheck(h.input, h.deps());
    expect(r).toMatchObject({ status: 'preview-unavailable', evidence: { reason } });
    expect(h.probes).toEqual([]);
    expect(h.commands).toEqual([]);
  });

  it.each(['//169.254.169.254/latest', '/\\10.0.0.5/x'])(
    'refuses a readyPath %s that resolves to another host, without probing or running the command',
    async (readyPath) => {
      const h = setup(previewAt('https://p.example.com'), { config: { ...config(), readyPath } });
      const r = await runPreviewCheck(h.input, h.deps());
      expect(r).toMatchObject({
        status: 'preview-unavailable',
        evidence: { reason: 'readyPath leaves the preview origin https://p.example.com' },
      });
      expect(h.probes).toEqual([]);
      expect(h.commands).toEqual([]);
    },
  );

  it('refuses a public hostname that resolves to a private address', async () => {
    const h = setup(previewAt('https://rebind.example.com'));
    const r = await runPreviewCheck(h.input, h.deps({ resolveHost: async () => ['93.184.216.34', '10.0.0.5'] }));
    expect(r.evidence.reason).toBe('preview host rebind.example.com resolves to non-public address 10.0.0.5');
    expect(h.probes).toEqual([]);
  });

  it('probes the address the host guard vetted, not a fresh resolution', async () => {
    const h = setup(previewAt('https://p.example.com'));
    const r = await runPreviewCheck(h.input, h.deps({ resolveHost: resolvesTo(['93.184.216.34'], ['93.184.216.34']) }));
    expect(r.status).toBe('pass');
    expect(h.pins).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('refuses when the host rebinds to a private address on a later poll', async () => {
    const h = setup(previewAt('https://p.example.com'));
    const r = await runPreviewCheck(
      h.input,
      h.deps({
        probe: async (url) => (h.probes.push(url), 503),
        resolveHost: resolvesTo(['93.184.216.34'], ['10.0.0.5']),
      }),
    );
    expect(r.evidence.reason).toBe('preview host p.example.com resolves to non-public address 10.0.0.5');
    expect(h.probes).toEqual(['https://p.example.com/']);
  });

  it('re-checks the host right before the command and refuses when it now resolves to a private address', async () => {
    const h = setup(previewAt('https://p.example.com'));
    const r = await runPreviewCheck(
      h.input,
      h.deps({ resolveHost: resolvesTo(['93.184.216.34'], ['169.254.169.254']) }),
    );
    expect(r).toMatchObject({
      status: 'preview-unavailable',
      evidence: { reason: 'preview host p.example.com resolves to non-public address 169.254.169.254' },
    });
    expect(h.probes).toEqual(['https://p.example.com/']);
    expect(h.commands).toEqual([]);
  });

  it('refuses to run the command when the pre-command host check cannot resolve', async () => {
    const h = setup(previewAt('https://p.example.com'));
    let calls = 0;
    const resolveHost = async () => {
      calls++;
      if (calls > 1) throw new Error('ENOTFOUND p.example.com');
      return ['93.184.216.34'];
    };
    const r = await runPreviewCheck(h.input, h.deps({ resolveHost }));
    expect(r.evidence.reason).toBe('preview host check failed: ENOTFOUND p.example.com');
    expect(h.commands).toEqual([]);
  });

  it('writes the evidence JSON to logsDir', async () => {
    const logsDir = join(tempDirs.makeSync('preview-logs-'), 'nested');
    const h = setup(previewAt('https://p.example.com'), { logsDir });
    const r = await runPreviewCheck(h.input, h.deps());
    expect(r.evidence.evidencePath).toBe(join(logsDir, 'preview-check.json'));
    const saved = JSON.parse(readFileSync(join(logsDir, 'preview-check.json'), 'utf8'));
    expect(saved).toMatchObject({ status: 'pass', evidence: { url: 'https://p.example.com/' } });
  });
});
