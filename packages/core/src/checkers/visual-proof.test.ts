import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VisualProofConfigSchema } from '../config/visual-proof-section.js';
import type { CommandResult } from '../utils/command-runner.js';
import {
  classifyVisualProof,
  runVisualProofCapture,
  validateVisualProofManifest,
  type VisualProofCaptureDeps,
  type VisualProofRoute,
} from './visual-proof.js';

const HEAD = 'a'.repeat(40);
const RUN = 'run-1';
const VIEWPORT = { width: 1280, height: 800 };

const config = VisualProofConfigSchema.parse({
  uiPaths: ['src/ui/**', 'web/*.css'],
  routes: [
    { route: '/settings', assert: 'Settings', paths: ['src/ui/settings/**'] },
    { route: '/home', assert: 'Welcome', paths: ['src/ui/home/**'] },
    { route: '/about', assert: 'About', paths: ['src/ui/about/**'] },
    { route: '/help', assert: 'Help', paths: ['src/ui/help/**'] },
  ],
  command: ['node', 'capture.mjs'],
  maxCaptures: 2,
});

const route = (r: string, assert = 'Settings'): VisualProofRoute => ({
  route: r,
  state: 'default',
  assert,
  viewport: VIEWPORT,
});

describe('classifyVisualProof', () => {
  it('is not required without config or plan routes', () => {
    expect(classifyVisualProof({ changedFiles: ['src/ui/a.ts'], config: undefined, planRoutes: [] })).toEqual({
      required: false,
    });
  });

  it('requires visualProof config when the plan names a screenshot', () => {
    const r = classifyVisualProof({ changedFiles: [], config: undefined, planRoutes: ['/settings'] });
    expect(r).toEqual({
      required: true,
      routes: [],
      diagnostic:
        "visual proof required by the plan's screenshot entries (/settings) but .factory config has no visualProof section — add visualProof.uiPaths, routes and command",
    });
  });

  it('is not required for non-UI changes', () => {
    expect(classifyVisualProof({ changedFiles: ['README.md', 'src/server.ts'], config, planRoutes: [] })).toEqual({
      required: false,
    });
  });

  it('requires proof from uiPaths even when the plan has no screenshot entry', () => {
    const r = classifyVisualProof({ changedFiles: ['src/ui/settings/form.tsx'], config, planRoutes: [] });
    expect(r).toMatchObject({ required: true, routes: [{ route: '/settings', state: 'default', assert: 'Settings' }] });
    expect(r).not.toHaveProperty('diagnostic');
  });

  it('selects only configured routes whose paths match changed files, capped at maxCaptures', () => {
    const r = classifyVisualProof({
      changedFiles: ['src/ui/home/a.ts', 'src/ui/about/b.ts', 'src/ui/help/c.ts'],
      config,
      planRoutes: [],
    });
    expect(r).toMatchObject({ required: true });
    if (r.required) {
      expect(r.routes.map((x) => x.route)).toEqual(['/home', '/about']);
      expect(r.diagnostic).toBeUndefined();
    }
  });

  it('reports uncovered UI files as a non-success', () => {
    const r = classifyVisualProof({ changedFiles: ['src/ui/settings/a.ts', 'web/app.css'], config, planRoutes: [] });
    expect(r).toMatchObject({
      required: true,
      diagnostic: 'UI files not covered by any visualProof route: web/app.css',
    });
  });

  it('selects a configured plan route and never invents an unconfigured one', () => {
    const r = classifyVisualProof({ changedFiles: [], config, planRoutes: ['/help', '/nope'] });
    expect(r).toMatchObject({
      required: true,
      routes: [{ route: '/help' }],
      diagnostic: 'plan screenshot route /nope is not in visualProof.routes',
    });
  });
});

describe('validateVisualProofManifest', () => {
  const outDir = resolve('/tmp/out');
  const png = (size = 4096): Buffer =>
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size)]);
  const capture = (patch: Record<string, unknown> = {}) => ({
    route: '/settings',
    state: 'default',
    viewport: VIEWPORT,
    finalPath: '/settings',
    assertion: { target: 'Settings', passed: true },
    file: '0.png',
    ...patch,
  });
  const manifest = (caps: Record<string, unknown>[] = [capture()], patch: Record<string, unknown> = {}) => ({
    headSha: HEAD,
    runId: RUN,
    captures: caps,
    ...patch,
  });
  const check = (raw: unknown, file: Buffer = png()) =>
    validateVisualProofManifest(raw, { headSha: HEAD, runId: RUN, outDir, routes: [route('/settings')] }, () => file);

  it('accepts a valid manifest', () => {
    const r = check(manifest());
    expect(r).toEqual({
      ok: true,
      captures: [
        {
          route: '/settings',
          state: 'default',
          viewport: VIEWPORT,
          finalPath: '/settings',
          file: '0.png',
          bytes: 4104,
        },
      ],
    });
  });

  it('rejects a manifest for another head or run', () => {
    expect(check(manifest([capture()], { headSha: 'b'.repeat(40) }))).toEqual({
      ok: false,
      diagnostic: 'capture is for another head/run',
    });
    expect(check(manifest([capture()], { runId: 'other' }))).toMatchObject({
      ok: false,
      diagnostic: 'capture is for another head/run',
    });
  });

  it('rejects a capture for an unconfigured route', () => {
    expect(check(manifest([capture({ route: '/admin' })]))).toMatchObject({
      ok: false,
      diagnostic: expect.stringContaining('unconfigured route /admin'),
    });
  });

  it('rejects a selected route without a capture', () => {
    expect(check(manifest([]))).toMatchObject({
      ok: false,
      diagnostic: expect.stringContaining('no capture for selected route /settings'),
    });
  });

  it('rejects a capture whose final path is a login redirect', () => {
    expect(check(manifest([capture({ finalPath: '/login' })]))).toMatchObject({
      ok: false,
      diagnostic: expect.stringContaining('landed on /login, expected /settings — login redirect or wrong page'),
    });
  });

  it('rejects a capture whose positive assertion did not pass', () => {
    expect(check(manifest([capture({ assertion: { target: 'Settings', passed: false } })]))).toMatchObject({
      ok: false,
    });
    expect(check(manifest([capture({ assertion: { target: 'Other', passed: true } })]))).toMatchObject({ ok: false });
  });

  it('rejects a viewport different from the configured one', () => {
    expect(check(manifest([capture({ viewport: { width: 800, height: 600 } })]))).toMatchObject({
      ok: false,
      diagnostic: expect.stringContaining('800x600'),
    });
  });

  it('rejects files outside the out dir', () => {
    for (const file of ['/etc/passwd.png', '../x.png', 'a/../../x.png']) {
      expect(check(manifest([capture({ file })]))).toMatchObject({
        ok: false,
        diagnostic: expect.stringContaining('outside the capture directory'),
      });
    }
  });

  it('rejects a blank or non-PNG capture', () => {
    expect(check(manifest(), Buffer.from('not a png'.repeat(500)))).toMatchObject({
      ok: false,
      diagnostic: expect.stringContaining('not a PNG'),
    });
    expect(check(manifest(), png(100))).toMatchObject({
      ok: false,
      diagnostic: expect.stringContaining('blank or empty image'),
    });
    expect(check(manifest(), png(6 * 1024 * 1024))).toMatchObject({
      ok: false,
      diagnostic: expect.stringContaining('5 MiB'),
    });
  });

  it('rejects an unreadable image, a malformed manifest and unknown keys', () => {
    const unreadable = validateVisualProofManifest(
      manifest(),
      { headSha: HEAD, runId: RUN, outDir, routes: [route('/settings')] },
      () => {
        throw new Error('ENOENT');
      },
    );
    expect(unreadable).toMatchObject({ ok: false, diagnostic: expect.stringContaining('could not be read') });
    expect(check({ nope: true })).toMatchObject({
      ok: false,
      diagnostic: expect.stringContaining('invalid capture manifest'),
    });
    expect(check(manifest([], { extra: 1 }))).toMatchObject({ ok: false });
  });
});

describe('runVisualProofCapture', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const logsDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'vp-test-'));
    dirs.push(d);
    return d;
  };
  const qa = { start: ['npm', 'start'], readyPath: '/', readyTimeoutSeconds: 5 };
  const requirement = { required: true as const, routes: [route('/settings')] };
  const cmdResult = (patch: Partial<CommandResult> = {}): CommandResult => ({
    command: [],
    stdout: '',
    stderr: '',
    exitCode: 0,
    killed: false,
    timedOut: false,
    ok: true,
    ...patch,
  });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4096)]);
  const goodManifest = Buffer.from(
    JSON.stringify({
      headSha: HEAD,
      runId: RUN,
      captures: [
        {
          route: '/settings',
          state: 'default',
          viewport: VIEWPORT,
          finalPath: '/settings',
          assertion: { target: 'Settings', passed: true },
          file: '0.png',
        },
      ],
    }),
  );
  const deps = (patch: Partial<VisualProofCaptureDeps> = {}) => {
    const startApp = vi.fn(() => ({
      pid: 1,
      exited: new Promise<never>(() => {}),
      output: () => '',
    }));
    const full: Partial<VisualProofCaptureDeps> = {
      startApp,
      probeReady: vi.fn(async () => 200),
      runCommand: vi.fn(async () => cmdResult()),
      killGroup: vi.fn(async () => undefined),
      sleep: async () => {},
      now: Date.now,
      readFile: (p: string) => (p.endsWith('manifest.json') ? goodManifest : png),
      ...patch,
    };
    return { full, startApp };
  };
  const input = (patch: Record<string, unknown> = {}) => ({
    requirement,
    qa,
    config,
    port: 3100,
    headSha: HEAD,
    runId: RUN,
    worktree: '/tmp/wt',
    logsDir: logsDir(),
    ...patch,
  });

  it('never starts the app or runs the command when proof is not required', async () => {
    const { full, startApp } = deps();
    const r = await runVisualProofCapture(input({ requirement: { required: false } }), full);
    expect(r.status).toBe('not-required');
    expect(startApp).not.toHaveBeenCalled();
    expect(full.runCommand).not.toHaveBeenCalled();
  });

  it('fails with the requirement diagnostic', async () => {
    const { full, startApp } = deps();
    const r = await runVisualProofCapture(input({ requirement: { ...requirement, diagnostic: 'uncovered' } }), full);
    expect(r).toMatchObject({ status: 'fail', diagnostic: 'uncovered' });
    expect(startApp).not.toHaveBeenCalled();
  });

  it('is unavailable without qa.start', async () => {
    const r = await runVisualProofCapture(input({ qa: null }), deps().full);
    expect(r).toMatchObject({ status: 'unavailable', diagnostic: expect.stringContaining('qa.start missing') });
  });

  it('fails with a remedy when no lane port is leased', async () => {
    const { full, startApp } = deps();
    const r = await runVisualProofCapture(input({ port: undefined }), full);
    expect(r).toMatchObject({ status: 'unavailable', diagnostic: 'no leased lane port — enable environment.ports' });
    expect(startApp).not.toHaveBeenCalled();
  });

  it('passes with validated captures and kills the start group', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'secret');
    vi.stubEnv('FACTORY_MERGE', '1');
    const { full } = deps({
      startApp: vi.fn((_argv, opts) => {
        opts.onPgid?.(42);
        return { pid: 42, exited: new Promise<never>(() => {}), output: () => '' };
      }),
    });
    const r = await runVisualProofCapture(input(), full);
    vi.unstubAllEnvs();
    expect(r.status).toBe('pass');
    expect(r.captures).toHaveLength(1);
    expect(full.killGroup).toHaveBeenCalledWith(42);
    const run = vi.mocked(full.runCommand as NonNullable<typeof full.runCommand>);
    const [argv, opts] = run.mock.calls[0] ?? [];
    expect(argv).toEqual(['node', 'capture.mjs']);
    expect(opts?.env).toMatchObject({
      VISUAL_PROOF_BASE_URL: 'http://127.0.0.1:3100',
      FACTORY_HEAD_SHA: HEAD,
      FACTORY_RUN_ID: RUN,
      HOST: '127.0.0.1',
      PORT: '3100',
    });
    expect(JSON.parse(opts?.env?.VISUAL_PROOF_ROUTES ?? '[]')).toEqual([route('/settings')]);
    expect(opts?.timeoutMs).toBe(300_000);
  });

  it('runs the capture with GITHUB_TOKEN and scrubbed vars removed and HOST bound to 127.0.0.1', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'secret');
    vi.stubEnv('GH_TOKEN', 'secret');
    vi.stubEnv('FACTORY_MERGE', '1');
    const startApp = vi.fn((_argv: readonly string[], _opts: { env: NodeJS.ProcessEnv }) => ({
      pid: 1,
      exited: new Promise<never>(() => {}),
      output: () => '',
    }));
    await runVisualProofCapture(input(), deps({ startApp }).full);
    vi.unstubAllEnvs();
    const opts = startApp.mock.calls[0]?.[1];
    expect(opts?.env.GITHUB_TOKEN).toBeUndefined();
    expect(opts?.env.GH_TOKEN).toBeUndefined();
    expect(opts?.env.FACTORY_MERGE).toBeUndefined();
    expect(opts?.env.HOST).toBe('127.0.0.1');
    expect(opts?.env.PORT).toBe('3100');
  });

  it('is unavailable when start exits before ready', async () => {
    const { full } = deps({
      startApp: () => ({ pid: 1, exited: Promise.resolve({ code: 1, signal: null }), output: () => 'boom' }),
      probeReady: async () => null,
    });
    const r = await runVisualProofCapture(input(), full);
    expect(r).toMatchObject({
      status: 'unavailable',
      diagnostic: expect.stringContaining('start exited (code 1) before ready: boom'),
    });
    expect(full.runCommand).not.toHaveBeenCalled();
  });

  it('is unavailable when the app never becomes ready', async () => {
    let t = 0;
    const { full } = deps({ probeReady: async () => 503, now: () => (t += 4000) });
    const r = await runVisualProofCapture(input(), full);
    expect(r).toMatchObject({
      status: 'unavailable',
      diagnostic: expect.stringContaining('not ready after 5s on http://127.0.0.1:3100/'),
    });
  });

  it('fails when the app answers 200 but the capture command exits non-zero', async () => {
    const { full } = deps({ runCommand: async () => cmdResult({ ok: false, exitCode: 2, stderr: 'browser missing' }) });
    const r = await runVisualProofCapture(input(), full);
    expect(r).toMatchObject({ status: 'fail', diagnostic: 'capture command exited 2: browser missing' });
  });

  it('fails on a capture timeout', async () => {
    const { full } = deps({
      runCommand: async () => cmdResult({ ok: false, timedOut: true, killed: true, exitCode: -1 }),
    });
    const r = await runVisualProofCapture(input(), full);
    expect(r).toMatchObject({ status: 'fail', diagnostic: 'capture command timed out after 300s' });
  });

  it('fails when the manifest is missing or invalid', async () => {
    const missing = await runVisualProofCapture(
      input(),
      deps({
        readFile: () => {
          throw new Error('ENOENT');
        },
      }).full,
    );
    expect(missing).toMatchObject({ status: 'fail', diagnostic: expect.stringContaining('manifest.json') });
    const wrongHead = Buffer.from(JSON.stringify({ headSha: 'b'.repeat(40), runId: RUN, captures: [] }));
    const stale = await runVisualProofCapture(input(), deps({ readFile: () => wrongHead }).full);
    expect(stale).toMatchObject({ status: 'fail', diagnostic: 'capture is for another head/run' });
  });
});
