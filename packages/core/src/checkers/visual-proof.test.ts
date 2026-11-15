import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { VisualProofConfigSchema } from '../config/visual-proof-section.js';
import { noisePng, okCommandResult } from '../test-support/visual-proof-fixtures.js';
import {
  classifyVisualProof,
  runVisualProofCapture,
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
    expect(r).toMatchObject({ required: true, uncovered: ['web/app.css'] });
    expect(r).not.toHaveProperty('diagnostic');
  });

  it('carries steps and record only for stateful routes', () => {
    const stateful = VisualProofConfigSchema.parse({
      uiPaths: ['src/ui/**'],
      routes: [
        { route: '/a', assert: 'A', paths: ['src/ui/a/**'], steps: [{ click: '#x' }], record: 'gif' },
        { route: '/b', assert: 'B', paths: ['src/ui/b/**'] },
      ],
      command: ['node', 'capture.mjs'],
    });
    const r = classifyVisualProof({
      changedFiles: ['src/ui/a/1.ts', 'src/ui/b/2.ts'],
      config: stateful,
      planRoutes: [],
    });
    expect(r).toMatchObject({ routes: [{ route: '/a', steps: [{ click: '#x' }], record: 'gif' }, { route: '/b' }] });
    if (r.required) expect(JSON.stringify(r.routes[1])).toBe(JSON.stringify(route('/b', 'B')));
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

describe('runVisualProofCapture', () => {
  const tempDirs = createTempDirs();
  afterEach(() => tempDirs.cleanup());
  const logsDir = () => tempDirs.makeSync('vp-test-');
  const qa = { start: ['npm', 'start'], readyPath: '/', readyTimeoutSeconds: 5 };
  const requirement = { required: true as const, routes: [route('/settings')] };
  const png = noisePng(4096);
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
      runCommand: vi.fn(async () => okCommandResult()),
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

  it('fails uncovered UI files under required listing every path', async () => {
    let started = 0;
    const { full } = deps({
      startApp: () => {
        started++;
        return { pid: 1, exited: new Promise<never>(() => {}), output: () => '' };
      },
    });
    const r = await runVisualProofCapture(
      input({ requirement: { ...requirement, uncovered: ['web/a.css', 'web/b.css'] } }),
      full,
    );
    expect(r).toMatchObject({
      status: 'fail',
      diagnostic: 'UI files not covered by any visualProof route: web/a.css, web/b.css',
    });
    expect(started).toBe(0);
  });

  it('captures covered routes and reports uncovered paths under advisory', async () => {
    const { full } = deps();
    const r = await runVisualProofCapture(
      input({ mode: 'advisory', requirement: { ...requirement, uncovered: ['web/a.css'] } }),
      full,
    );
    expect(r).toMatchObject({ status: 'pass', uncovered: ['web/a.css'], attempts: 1 });
    const none = await runVisualProofCapture(
      input({ mode: 'advisory', requirement: { required: true as const, routes: [], uncovered: ['web/a.css'] } }),
      full,
    );
    expect(none).toMatchObject({ status: 'fail', diagnostic: expect.stringContaining('web/a.css') });
  });

  it('fails when the app answers 200 but the capture command exits non-zero', async () => {
    const { full } = deps({
      runCommand: async () => okCommandResult({ ok: false, exitCode: 2, stderr: 'browser missing' }),
    });
    const r = await runVisualProofCapture(input(), full);
    expect(r).toMatchObject({
      status: 'fail',
      attempts: 3,
      diagnostic: 'after 3 attempts: capture command exited 2: browser missing',
    });
  });

  it('fails on a capture timeout', async () => {
    const { full } = deps({
      runCommand: async () => okCommandResult({ ok: false, timedOut: true, killed: true, exitCode: -1 }),
    });
    const r = await runVisualProofCapture(input(), full);
    expect(r).toMatchObject({ status: 'fail', diagnostic: 'after 3 attempts: capture command timed out after 300s' });
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
    expect(stale).toMatchObject({ status: 'fail', diagnostic: 'after 3 attempts: capture is for another head/run' });
  });
});
