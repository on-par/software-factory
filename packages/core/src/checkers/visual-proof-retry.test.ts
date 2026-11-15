import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { VisualProofConfigSchema, type VisualProofStep } from '../config/visual-proof-section.js';
import { createTempDirs } from '../harness/temp-dir.js';
import type { CommandResult } from '../utils/command-runner.js';
import {
  classifyVisualProof,
  runVisualProofCapture,
  type VisualProofCaptureDeps,
  type VisualProofRoute,
} from './visual-proof.js';
import { cmdResult, noisePng, solidPng } from '../test-support/visual-proof-test-helpers.js';

const HEAD = 'a'.repeat(40);
const RUN = 'run-1';
const VIEWPORT = { width: 1280, height: 800 };
const steps: VisualProofStep[] = [{ click: '#new' }, { waitFor: '#item-1' }];

const plainRoute: VisualProofRoute = { route: '/settings', state: 'default', assert: 'Settings', viewport: VIEWPORT };
const statefulRoute: VisualProofRoute = {
  route: '/items',
  state: 'item-created',
  assert: '#item-1',
  viewport: VIEWPORT,
  steps,
  record: 'gif',
};

const config = VisualProofConfigSchema.parse({
  uiPaths: ['src/ui/**'],
  routes: [
    { route: '/settings', assert: 'Settings', paths: ['src/ui/settings/**'] },
    { route: '/items', state: 'item-created', assert: '#item-1', paths: ['src/ui/items/**'], steps, record: 'gif' },
  ],
  command: ['node', 'capture.mjs'],
});

const capturedEntry = (route: VisualProofRoute) => ({
  route: route.route,
  state: route.state,
  viewport: VIEWPORT,
  finalPath: route.route,
  assertion: { target: route.assert, passed: true },
  file: 'after.png',
  ...(route.steps
    ? {
        before: { file: 'before.png', finalPath: route.route },
        steps: route.steps,
        clip: { file: 'clip.gif', format: 'gif' },
      }
    : {}),
});

const writeCapture = (outDir: string, route: VisualProofRoute, after: Buffer, extra: Record<string, unknown> = {}) => {
  writeFileSync(join(outDir, 'after.png'), after);
  writeFileSync(join(outDir, 'before.png'), noisePng(4096, 9));
  writeFileSync(join(outDir, 'clip.gif'), Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64)]));
  writeFileSync(
    join(outDir, 'manifest.json'),
    JSON.stringify({ headSha: HEAD, runId: RUN, captures: [capturedEntry(route)], ...extra }),
  );
};

describe('runVisualProofCapture retries and steps (#4054)', () => {
  const tempDirs = createTempDirs();
  afterEach(() => tempDirs.cleanup());
  const qa = { start: ['npm', 'start'], readyPath: '/', readyTimeoutSeconds: 5 };
  const noEnv: NodeJS.ProcessEnv = {};
  const rig = (
    behave: (attempt: number, env: NodeJS.ProcessEnv) => CommandResult,
    patch: Partial<VisualProofCaptureDeps> = {},
  ) => {
    const rec = { envs: [] as NodeJS.ProcessEnv[], starts: 0, logs: [] as string[] };
    const deps: Partial<VisualProofCaptureDeps> = {
      startApp: () => {
        rec.starts += 1;
        return { pid: 1, exited: new Promise<never>(() => {}), output: () => '' };
      },
      probeReady: async () => 200,
      runCommand: async (_argv, opts) => {
        rec.envs.push(opts.env);
        return behave(rec.envs.length, opts.env);
      },
      killGroup: async () => undefined,
      sleep: async () => {},
      now: Date.now,
      ...patch,
    };
    const log = (message: string): void => {
      rec.logs.push(message);
    };
    return { rec, deps, log };
  };
  const input = (routes: VisualProofRoute[], patch: Record<string, unknown> = {}) => ({
    requirement: { required: true as const, routes },
    qa,
    config,
    port: 3100,
    headSha: HEAD,
    runId: RUN,
    worktree: '/tmp/wt',
    logsDir: tempDirs.makeSync('vp-retry-'),
    ...patch,
  });
  const writing = (route: VisualProofRoute, after: Buffer) => (_attempt: number, env: NodeJS.ProcessEnv) => {
    writeCapture(env.VISUAL_PROOF_OUT_DIR ?? '', route, after);
    return cmdResult();
  };

  it('a stateful route passes through the capture and keeps before, steps and clip', async () => {
    const { deps } = rig(writing(statefulRoute, noisePng(4096, 2)));
    const r = await runVisualProofCapture(input([statefulRoute]), deps);
    expect(r.status).toBe('pass');
    expect(r.attempts).toBe(1);
    expect(r.captures[0]).toMatchObject({ before: { file: 'before.png' }, steps, clip: { format: 'gif' } });
    expect(r.outDir).toContain('attempt-1');
  });

  it('retries a blank capture and then reports it, never passing', async () => {
    const { rec, deps, log } = rig(writing(plainRoute, solidPng()));
    const r = await runVisualProofCapture(input([plainRoute], { log }), deps);
    expect(rec.envs).toHaveLength(3);
    expect(rec.logs).toHaveLength(3);
    expect(rec.logs[0]).toContain('visual proof capture attempt 1/3 failed');
    expect(r.status).toBe('fail');
    expect(r.attempts).toBe(3);
    expect(r.diagnostic).toContain('after 3 attempts:');
    expect(r.diagnostic).toContain('blank');
  });

  it('retries a failed capture up to captureAttempts and logs each reason', async () => {
    const good = writing(plainRoute, noisePng(4096, 3));
    const { rec, deps, log } = rig((attempt, env) =>
      attempt === 1 ? cmdResult({ ok: false, exitCode: 2, stderr: 'flaky browser' }) : good(attempt, env),
    );
    const r = await runVisualProofCapture(input([plainRoute], { log }), deps);
    expect(r.status).toBe('pass');
    expect(r.attempts).toBe(2);
    expect(rec.logs).toEqual(['visual proof capture attempt 1/3 failed: capture command exited 2: flaky browser']);
  });

  it('honours a lower captureAttempts', async () => {
    const { rec, deps } = rig(() => cmdResult({ ok: false, exitCode: 1 }));
    const lowered = { ...config, captureAttempts: 1 };
    const r = await runVisualProofCapture(input([plainRoute], { config: lowered }), deps);
    expect(rec.envs).toHaveLength(1);
    expect(r.diagnostic).toBe('after 1 attempts: capture command exited 1');
  });

  it('retries when the app never becomes ready', async () => {
    let t = 0;
    const { rec, deps, log } = rig(() => cmdResult(), { probeReady: async () => 503, now: () => (t += 4000) });
    const r = await runVisualProofCapture(input([plainRoute], { log }), deps);
    expect(rec.starts).toBe(3);
    expect(rec.envs).toHaveLength(0);
    expect(rec.logs).toHaveLength(3);
    expect(r).toMatchObject({ status: 'unavailable', attempts: 3 });
    expect(r.diagnostic).toContain('after 3 attempts: app not ready');
  });

  it('passes steps and record through VISUAL_PROOF_ROUTES only for stateful routes', async () => {
    const { rec, deps } = rig(() => cmdResult({ ok: false, exitCode: 1 }));
    await runVisualProofCapture(
      input([plainRoute, statefulRoute], { config: { ...config, captureAttempts: 1 } }),
      deps,
    );
    const env = rec.envs[0] ?? noEnv;
    const sent = JSON.parse(env.VISUAL_PROOF_ROUTES ?? '[]');
    expect(sent[0]).toEqual(plainRoute);
    expect(sent[1]).toMatchObject({ steps, record: 'gif' });
    expect(env.VISUAL_PROOF_MAX_CLIP_BYTES).toBe(String(10 * 1024 * 1024));
  });

  it('serializes a stepless route exactly as before', () => {
    const r = classifyVisualProof({ changedFiles: ['src/ui/settings/a.ts'], config, planRoutes: [] });
    if (!r.required) throw new Error('expected a requirement');
    expect(JSON.stringify(r.routes)).toBe(
      JSON.stringify([{ route: '/settings', state: 'default', assert: 'Settings', viewport: VIEWPORT }]),
    );
  });

  it('fails uncovered UI files under required listing every path', async () => {
    const { rec, deps } = rig(() => cmdResult());
    const requirement = { required: true as const, routes: [plainRoute], uncovered: ['web/a.css', 'web/b.css'] };
    const r = await runVisualProofCapture(input([plainRoute], { requirement }), deps);
    expect(r).toMatchObject({
      status: 'fail',
      diagnostic: 'UI files not covered by any visualProof route: web/a.css, web/b.css',
    });
    expect(rec.envs).toHaveLength(0);
  });

  it('captures covered routes and reports uncovered paths under advisory', async () => {
    const { deps } = rig(writing(plainRoute, noisePng(4096, 3)));
    const requirement = { required: true as const, routes: [plainRoute], uncovered: ['web/a.css'] };
    const r = await runVisualProofCapture(input([plainRoute], { requirement, mode: 'advisory' }), deps);
    expect(r).toMatchObject({ status: 'pass', uncovered: ['web/a.css'] });
    const nothing = { required: true as const, routes: [], uncovered: ['web/a.css'] };
    const empty = await runVisualProofCapture(input([], { requirement: nothing, mode: 'advisory' }), deps);
    expect(empty).toMatchObject({ status: 'fail', diagnostic: expect.stringContaining('web/a.css') });
  });
});
