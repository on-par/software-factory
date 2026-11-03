import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { describe, expect, it } from 'vitest';

import { PreviewConfigSchema } from '../config/preview-section.js';
import type { CommandResult } from '../utils/command-runner.js';
import { previewReworkSummary, runPreviewCheck, type PreviewCheckInput } from './preview-check.js';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

interface Fixtures {
  deployments?: { id: number; sha: string; environment: string; created_at: string }[];
  statuses?: Record<number, { state: string; created_at: string; environment_url?: string; target_url?: string }[]>;
  comments?: { body: string }[];
}

/** Proxy octokit: read endpoints answer from fixtures, anything else throws. */
function fakeOctokit(f: Fixtures): Octokit {
  const reads: Record<string, (args: any) => unknown> = {
    listDeployments: (a) => ({ data: (f.deployments ?? []).filter((d) => d.sha === a.sha) }),
    listDeploymentStatuses: (a) => ({ data: f.statuses?.[a.deployment_id] ?? [] }),
    listComments: () => ({ data: f.comments ?? [] }),
  };
  const ns = (): unknown =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => {
          const read = reads[method];
          if (!read) throw new Error(`write/unknown GitHub call: ${method}`);
          return async (a: unknown) => read(a);
        },
      },
    );
  return { rest: { repos: ns(), issues: ns() } } as Octokit;
}

const okResult = (over: Partial<CommandResult> = {}): CommandResult =>
  ({ ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false, ...over }) as CommandResult;

const deploymentConfig = (over: Record<string, unknown> = {}) =>
  PreviewConfigSchema.parse({
    source: { kind: 'deployment', environment: 'preview/pr-*' },
    command: ['npm', 'run', 'smoke'],
    ...over,
  });

function harness(f: Fixtures, config = deploymentConfig(), over: Partial<PreviewCheckInput> = {}) {
  const calls: { argv: readonly string[]; env: Record<string, string | undefined> }[] = [];
  const probes: string[] = [];
  let clock = 0;
  const input: PreviewCheckInput = {
    config,
    octokit: fakeOctokit(f),
    owner: 'o',
    repo: 'r',
    prNumber: 7,
    headSha: SHA,
    worktree: mkdtempSync(join(tmpdir(), 'preview-')),
    ...over,
  };
  return { calls, probes, input, tick: (ms: number) => (clock += ms), clock: () => clock };
}

const dep = { id: 1, sha: SHA, environment: 'preview/pr-7', created_at: '2026-01-01T00:00:00Z' };

describe('runPreviewCheck', () => {
  it('deployment source runs the command with PREVIEW_URL set to the matching deployment URL', async () => {
    const h = harness({
      deployments: [
        { ...dep, id: 1, created_at: '2026-01-01T00:00:00Z' },
        { ...dep, id: 2, created_at: '2026-01-02T00:00:00Z' },
        { ...dep, id: 3, sha: OTHER, created_at: '2026-01-03T00:00:00Z' },
        { ...dep, id: 4, environment: 'production', created_at: '2026-01-04T00:00:00Z' },
      ],
      statuses: {
        1: [{ state: 'success', created_at: '2026-01-01T00:00:00Z', environment_url: 'https://old.example.com' }],
        2: [
          { state: 'success', created_at: '2026-01-02T00:00:00Z', environment_url: 'https://new.example.com' },
          { state: 'in_progress', created_at: '2026-01-02T00:01:00Z', environment_url: 'https://x.example.com' },
        ],
      },
    });
    // newest status of deployment 2 is not success => falls back to deployment 1
    const r = await runPreviewCheck(h.input, {
      probe: async () => 200,
      sleep: async () => {},
      now: () => 0,
      runCommand: async (argv, o) => {
        h.calls.push({ argv, env: o.env ?? {} });
        return okResult();
      },
    });
    expect(r.status).toBe('pass');
    expect(h.calls[0]?.env.PREVIEW_URL).toBe('https://old.example.com');
    expect(r.evidence.url).toBe('https://old.example.com');
  });

  it('uses the newest successful deployment status URL, falling back to target_url', async () => {
    const h = harness({
      deployments: [dep],
      statuses: { 1: [{ state: 'success', created_at: '2026-01-01T00:00:00Z', target_url: 'https://t.example.com' }] },
    });
    const r = await runPreviewCheck(h.input, { probe: async () => 200, runCommand: async () => okResult() });
    expect(r.evidence.url).toBe('https://t.example.com');
  });

  it('comment source uses the URL captured from the newest matching PR comment', async () => {
    const named = harness(
      { comments: [{ body: 'Preview: https://old.example.com' }, { body: 'Preview: https://new.example.com ok' }] },
      PreviewConfigSchema.parse({
        source: { kind: 'comment', urlPattern: 'Preview: (?<url>https://\\S+)' },
        command: ['x'],
      }),
    );
    const r1 = await runPreviewCheck(named.input, { probe: async () => 200, runCommand: async () => okResult() });
    expect(r1.evidence.url).toBe('https://new.example.com');
    const grouped = harness(
      { comments: [{ body: 'deployed to https://g.example.com' }, { body: 'unrelated' }] },
      PreviewConfigSchema.parse({ source: { kind: 'comment', urlPattern: 'deployed to (\\S+)' }, command: ['x'] }),
    );
    const r2 = await runPreviewCheck(grouped.input, { probe: async () => 200, runCommand: async () => okResult() });
    expect(r2.evidence.url).toBe('https://g.example.com');
  });

  it('waits until the preview answers the expected status before running the command', async () => {
    const h = harness({
      deployments: [dep],
      statuses: {
        1: [{ state: 'success', created_at: '2026-01-01T00:00:00Z', environment_url: 'https://p.example.com' }],
      },
    });
    const statuses: (number | null)[] = [null, 503, 200];
    let ran = 0;
    const r = await runPreviewCheck(h.input, {
      probe: async (u) => {
        h.probes.push(u);
        return statuses.shift() as number | null;
      },
      sleep: async (ms) => void h.tick(ms),
      now: h.clock,
      runCommand: async () => {
        ran++;
        expect(h.probes).toHaveLength(3);
        return okResult();
      },
    });
    expect(r.status).toBe('pass');
    expect(ran).toBe(1);
  });

  it('polls the configured readyPath for the configured expectedStatus', async () => {
    const h = harness(
      {
        deployments: [dep],
        statuses: {
          1: [{ state: 'success', created_at: '2026-01-01T00:00:00Z', environment_url: 'https://p.example.com' }],
        },
      },
      deploymentConfig({ readyPath: '/healthz', expectedStatus: 204 }),
    );
    const r = await runPreviewCheck(h.input, {
      probe: async (u) => {
        h.probes.push(u);
        return u === 'https://p.example.com/healthz' ? 204 : 200;
      },
      runCommand: async () => okResult(),
    });
    expect(h.probes).toEqual(['https://p.example.com/healthz']);
    expect(r.status).toBe('pass');
  });

  it('sets the configured urlEnv instead of PREVIEW_URL', async () => {
    const h = harness(
      {
        deployments: [dep],
        statuses: {
          1: [{ state: 'success', created_at: '2026-01-01T00:00:00Z', environment_url: 'https://p.example.com' }],
        },
      },
      deploymentConfig({ urlEnv: 'BASE' }),
      { env: { KEEP: '1' } },
    );
    await runPreviewCheck(h.input, {
      probe: async () => 200,
      runCommand: async (argv, o) => {
        h.calls.push({ argv, env: o.env ?? {} });
        return okResult();
      },
    });
    expect(h.calls[0]?.env).toEqual({ KEEP: '1', BASE: 'https://p.example.com' });
  });

  it('reports fail with url, headSha, command, exitCode, durationMs, outputTail and artifacts', async () => {
    const h = harness(
      {
        deployments: [dep],
        statuses: {
          1: [{ state: 'success', created_at: '2026-01-01T00:00:00Z', environment_url: 'https://p.example.com' }],
        },
      },
      deploymentConfig({ artifacts: ['report/out.html', 'missing.txt'] }),
    );
    mkdirSync(join(h.input.worktree, 'report'));
    writeFileSync(join(h.input.worktree, 'report/out.html'), '<html/>');
    let t = 0;
    const r = await runPreviewCheck(h.input, {
      probe: async () => 200,
      now: () => (t += 10),
      runCommand: async () => okResult({ ok: false, exitCode: 2, stderr: '\u001b[31mboom\u001b[0m' }),
    });
    expect(r.status).toBe('fail');
    expect(r.evidence).toMatchObject({
      url: 'https://p.example.com',
      headSha: SHA,
      command: ['npm', 'run', 'smoke'],
      exitCode: 2,
      outputTail: 'boom',
      artifacts: ['report/out.html'],
    });
    expect(r.evidence.durationMs).toBeGreaterThan(0);
    expect(previewReworkSummary(r)).toContain('Exit code: 2');
    expect(previewReworkSummary(r)).toContain('boom');
  });

  it('reports preview-unavailable when no URL is found before the timeout', async () => {
    const h = harness({}, deploymentConfig({ readyTimeoutSeconds: 12 }));
    const r = await runPreviewCheck(h.input, {
      sleep: async (ms) => void h.tick(ms),
      now: h.clock,
      runCommand: async () => {
        throw new Error('must not run');
      },
    });
    expect(r.status).toBe('preview-unavailable');
    expect(r.evidence.reason).toBe(
      `no preview URL found for ${SHA.slice(0, 12)} (deployment environment preview/pr-*)`,
    );
    expect(previewReworkSummary(r)).toContain('Reason: no preview URL');
  });

  it('reports preview-unavailable when the preview never becomes ready', async () => {
    const h = harness(
      {
        deployments: [dep],
        statuses: {
          1: [{ state: 'success', created_at: '2026-01-01T00:00:00Z', environment_url: 'https://p.example.com' }],
        },
      },
      deploymentConfig({ readyTimeoutSeconds: 10 }),
    );
    const r = await runPreviewCheck(h.input, {
      probe: async () => 502,
      sleep: async (ms) => void h.tick(ms),
      now: h.clock,
    });
    expect(r.status).toBe('preview-unavailable');
    expect(r.evidence.reason).toBe('preview https://p.example.com not ready (last status 502) after 10s');
    expect(r.evidence.url).toBe('https://p.example.com');
  });

  it('retries a lookup error and records it as the reason', async () => {
    const h = harness({}, deploymentConfig({ readyTimeoutSeconds: 5 }));
    const r = await runPreviewCheck(h.input, {
      findUrl: async () => {
        throw new Error('api down');
      },
      sleep: async (ms) => void h.tick(ms),
      now: h.clock,
    });
    expect(r.evidence.reason).toBe('preview lookup failed: api down');
  });

  it('only reads deployments and comments and never calls a GitHub write API', async () => {
    const h = harness({ deployments: [dep], comments: [{ body: 'x' }] }, deploymentConfig({ readyTimeoutSeconds: 5 }));
    await expect(
      runPreviewCheck(h.input, { sleep: async (ms) => void h.tick(ms), now: h.clock }),
    ).resolves.toMatchObject({ status: 'preview-unavailable' });
    const octokit = h.input.octokit as any;
    expect(() => octokit.rest.repos.createDeployment).toThrow('write/unknown');
  });

  it('writes the evidence JSON to logsDir', async () => {
    const logsDir = join(mkdtempSync(join(tmpdir(), 'preview-logs-')), 'nested');
    const h = harness(
      {
        deployments: [dep],
        statuses: {
          1: [{ state: 'success', created_at: '2026-01-01T00:00:00Z', environment_url: 'https://p.example.com' }],
        },
      },
      deploymentConfig(),
      { logsDir },
    );
    const r = await runPreviewCheck(h.input, { probe: async () => 200, runCommand: async () => okResult() });
    expect(r.evidence.evidencePath).toBe(join(logsDir, 'preview-check.json'));
    const saved = JSON.parse(readFileSync(join(logsDir, 'preview-check.json'), 'utf8'));
    expect(saved.status).toBe('pass');
    expect(saved.evidence.url).toBe('https://p.example.com');
  });
});
