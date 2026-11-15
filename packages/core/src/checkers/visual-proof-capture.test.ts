import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { VisualProofConfigSchema } from '../config/visual-proof-section.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { noisePng, okCommandResult, solidPng } from '../test-support/visual-proof-fixtures.js';
import { MAX_CLIP_BYTES } from './visual-proof-manifest.js';
import { runVisualProofCapture, type VisualProofCaptureDeps, type VisualProofRoute } from './visual-proof.js';

const HEAD = 'a'.repeat(40);
const RUN = 'run-1';
const VIEWPORT = { width: 1280, height: 800 };

const config = VisualProofConfigSchema.parse({
  uiPaths: ['src/ui/**'],
  routes: [{ route: '/settings', assert: 'Settings', paths: ['src/ui/settings/**'] }],
  command: ['node', 'capture.mjs'],
});

const route = (r: string, assert = 'Settings'): VisualProofRoute => ({
  route: r,
  state: 'default',
  assert,
  viewport: VIEWPORT,
});

describe('runVisualProofCapture with a capture command that writes real files', () => {
  const tempDirs = createTempDirs();
  afterEach(() => tempDirs.cleanup());
  const qa = { start: ['npm', 'start'], readyPath: '/', readyTimeoutSeconds: 5 };
  const requirement = { required: true as const, routes: [route('/settings')] };
  const deps = (patch: Partial<VisualProofCaptureDeps> = {}): Partial<VisualProofCaptureDeps> => ({
    startApp: () => ({ pid: 1, exited: new Promise<never>(() => {}), output: () => '' }),
    probeReady: async () => 200,
    killGroup: async () => undefined,
    sleep: async () => {},
    now: Date.now,
    ...patch,
  });
  const input = (patch: Record<string, unknown> = {}) => ({
    requirement,
    qa,
    config,
    port: 3100,
    headSha: HEAD,
    runId: RUN,
    worktree: '/tmp/wt',
    logsDir: tempDirs.makeSync('vp-capture-'),
    ...patch,
  });
  const statefulRoute: VisualProofRoute = {
    route: '/items',
    state: 'item-created',
    assert: '#item-1',
    viewport: VIEWPORT,
    steps: [{ click: '#new' }, { waitFor: '#item-1' }],
    record: 'gif',
  };
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64)]);
  const writeCapture = (outDir: string, extra: Record<string, unknown> = {}, images?: { after: Buffer }) => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'after.png'), images?.after ?? noisePng(4096, 2));
    writeFileSync(join(outDir, 'before.png'), noisePng(4096, 3));
    writeFileSync(join(outDir, 'clip.gif'), gif);
    writeFileSync(
      join(outDir, 'manifest.json'),
      JSON.stringify({
        headSha: HEAD,
        runId: RUN,
        captures: [
          {
            route: '/items',
            state: 'item-created',
            viewport: VIEWPORT,
            finalPath: '/items',
            assertion: { target: '#item-1', passed: true },
            file: 'after.png',
            before: { file: 'before.png', finalPath: '/items' },
            steps: statefulRoute.steps,
            clip: { file: 'clip.gif', format: 'gif' },
            ...extra,
          },
        ],
      }),
    );
  };
  const fsDeps = (onAttempt: (attempt: number, outDir: string) => void) => {
    const outDirs: string[] = [];
    const envs: NodeJS.ProcessEnv[] = [];
    const full = deps({
      runCommand: async (_argv, opts) => {
        const outDir = opts.env.VISUAL_PROOF_OUT_DIR ?? '';
        outDirs.push(outDir);
        envs.push(opts.env);
        onAttempt(outDirs.length, outDir);
        return okCommandResult();
      },
    });
    return { full, outDirs, envs };
  };
  const statefulInput = (patch: Record<string, unknown> = {}) =>
    input({ requirement: { required: true as const, routes: [statefulRoute] }, ...patch });

  it('a stateful route produces before and after captures and a clip', async () => {
    const { full, outDirs } = fsDeps((_n, dir) => writeCapture(dir));
    const r = await runVisualProofCapture(statefulInput(), full);
    expect(r).toMatchObject({
      status: 'pass',
      attempts: 1,
      captures: [
        { route: '/items', before: { file: 'before.png' }, clip: { format: 'gif' }, steps: statefulRoute.steps },
      ],
    });
    expect(outDirs).toHaveLength(1);
    expect(r.outDir).toBe(outDirs[0]);
  });

  it('a broken selector fails with a reason naming the step', async () => {
    const { full } = fsDeps((_n, dir) => {
      writeCapture(dir);
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      manifest.failures = [{ route: '/items', state: 'item-created', step: 2, message: 'no element for #missing' }];
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    });
    const stepRoute = { ...statefulRoute, steps: [{ goto: '/items' }, { click: '#missing' }] };
    const r = await runVisualProofCapture(
      input({ requirement: { required: true as const, routes: [stepRoute] } }),
      full,
    );
    expect(r.status).toBe('fail');
    expect(r.diagnostic).toContain('step 2 click "#missing" failed: no element for #missing');
  });

  it('retries a blank capture and then reports it, never passing', async () => {
    const logs: string[] = [];
    const { full, outDirs } = fsDeps((_n, dir) => writeCapture(dir, {}, { after: solidPng() }));
    const r = await runVisualProofCapture(statefulInput({ log: (m: string) => logs.push(m) }), full);
    expect(outDirs).toHaveLength(3);
    expect(logs).toHaveLength(3);
    expect(logs[0]).toContain('visual proof capture attempt 1/3 failed');
    expect(r.status).toBe('fail');
    expect(r.attempts).toBe(3);
    expect(r.diagnostic).toContain('after 3 attempts:');
    expect(r.diagnostic).toContain('blank');
    expect(new Set(outDirs).size).toBe(3);
  });

  it('retries a failed capture up to captureAttempts and logs each reason', async () => {
    const logs: string[] = [];
    const { full, outDirs } = fsDeps((n, dir) => {
      if (n === 1) writeCapture(dir, { finalPath: '/login' });
      else writeCapture(dir);
    });
    const r = await runVisualProofCapture(statefulInput({ log: (m: string) => logs.push(m) }), full);
    expect(r).toMatchObject({ status: 'pass', attempts: 2 });
    expect(outDirs).toHaveLength(2);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('attempt 1/3 failed');
    expect(logs[0]).toContain('landed on /login');
  });

  it('honours a captureAttempts of 1 by not retrying', async () => {
    const { full, outDirs } = fsDeps((_n, dir) => writeCapture(dir, { finalPath: '/login' }));
    const one = { ...config, captureAttempts: 1 };
    const r = await runVisualProofCapture(statefulInput({ config: one }), full);
    expect(outDirs).toHaveLength(1);
    expect(r).toMatchObject({ status: 'fail', attempts: 1 });
  });

  it('retries when the app never becomes ready', async () => {
    let starts = 0;
    const logs: string[] = [];
    let t = 0;
    const full = deps({
      startApp: () => {
        starts++;
        return { pid: 1, exited: new Promise<never>(() => {}), output: () => '' };
      },
      probeReady: async () => 503,
      now: () => (t += 4000),
    });
    const r = await runVisualProofCapture(input({ log: (m: string) => logs.push(m) }), full);
    expect(starts).toBe(3);
    expect(logs).toHaveLength(3);
    expect(r).toMatchObject({ status: 'unavailable', attempts: 3 });
    expect(r.diagnostic).toContain('after 3 attempts: app not ready');
  });

  it('rejects a stateful after capture identical to before', async () => {
    const { full } = fsDeps((_n, dir) => {
      writeCapture(dir);
      writeFileSync(join(dir, 'after.png'), noisePng(4096, 3));
    });
    const r = await runVisualProofCapture(statefulInput(), full);
    expect(r.status).toBe('fail');
    expect(r.diagnostic).toContain('identical to before');
  });

  it('rejects a clip over the size cap or with the wrong format', async () => {
    const tooBig = fsDeps((_n, dir) => {
      writeCapture(dir);
      writeFileSync(join(dir, 'clip.gif'), Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(MAX_CLIP_BYTES)]));
    });
    expect((await runVisualProofCapture(statefulInput(), tooBig.full)).diagnostic).toContain('clip exceeds 10 MiB');
    const wrong = fsDeps((_n, dir) => {
      writeCapture(dir);
      writeFileSync(join(dir, 'clip.gif'), Buffer.from('not a gif at all'));
    });
    expect((await runVisualProofCapture(statefulInput(), wrong.full)).diagnostic).toContain('clip is not a gif');
  });

  it('passes steps and record through VISUAL_PROOF_ROUTES only for stateful routes', async () => {
    const plain = route('/settings');
    const { full, envs } = fsDeps((_n, dir) => writeCapture(dir));
    await runVisualProofCapture(
      input({ requirement: { required: true as const, routes: [statefulRoute, plain] } }),
      full,
    );
    const routes = JSON.parse(envs[0]?.VISUAL_PROOF_ROUTES ?? '[]');
    expect(routes[0]).toMatchObject({ steps: statefulRoute.steps, record: 'gif' });
    expect(routes[1]).not.toHaveProperty('steps');
    expect(routes[1]).not.toHaveProperty('record');
    expect(envs[0]?.VISUAL_PROOF_MAX_CLIP_BYTES).toBe(String(MAX_CLIP_BYTES));
  });

  it('serializes a stepless route exactly as before', async () => {
    const { full, envs } = fsDeps(() => undefined);
    await runVisualProofCapture(input(), full);
    expect(envs[0]?.VISUAL_PROOF_ROUTES).toBe(
      '[{"route":"/settings","state":"default","assert":"Settings","viewport":{"width":1280,"height":800}}]',
    );
  });
});
