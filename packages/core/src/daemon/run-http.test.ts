import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { writeRegistry } from './registry.js';
import { createRunRuntime } from './run-runtime.js';
import { createFactorydServer, type FactorydServer } from './factoryd-http.js';
let dir: string;
let server: FactorydServer;
let base: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'run-http-'));
  const registryFile = join(dir, 'registry.json');
  await writeRegistry(registryFile, {
    version: 1,
    repos: { 'test/repo': { path: dir, attachedAt: new Date().toISOString(), state: 'active' } },
  });
  const runRuntime = await createRunRuntime({
    registryFile,
    execute: async ({ signal, output }) => {
      output('working');
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ exitCode: null, prUrl: null })));
    },
  });
  server = createFactorydServer({ registryFile, port: 0, runRuntime, log: () => {} });
  base = `http://127.0.0.1:${await server.start()}`;
});
afterEach(async () => {
  await server?.stop();
  await rm(dir, { recursive: true, force: true });
});
const post = (path: string, body: unknown, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
it('accepts once, reconnects to the same durable run, exposes logs and cancels', async () => {
  const input = { runId: randomUUID(), repo: 'test/repo', issue: 1 };
  const response = await post('/runs', input);
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ run: input });
  expect(await (await post('/runs', input)).json()).toMatchObject({ run: input });
  expect((await post('/runs', { ...input, issue: 2 })).status).toBe(409);
  expect(await (await fetch(`${base}/runs`)).json()).toMatchObject({ runs: [input] });
  await expect
    .poll(async () => ((await (await fetch(`${base}/runs/${input.runId}/logs`)).json()) as { text: string }).text)
    .toBe('working');
  expect(await (await fetch(`${base}/runs/${input.runId}`)).json()).toMatchObject({ run: { status: 'running' } });
  expect(await (await post(`/runs/${input.runId}/cancel`, {})).json()).toMatchObject({ run: { status: 'canceled' } });
  expect((await fetch(`${base}/runs/missing`)).status).toBe(404);
});
it('blocks browser cross-origin writes and DNS rebinding even though the listener is local', async () => {
  const input = { runId: randomUUID(), repo: 'test/repo', issue: 1 };
  expect((await post('/runs', input, { origin: 'https://attacker.example' })).status).toBe(403);
  const reboundStatus = await new Promise<number | undefined>((resolve, reject) => {
    const request = http.request(
      `${base}/runs`,
      { method: 'POST', headers: { host: 'attacker.example', 'content-type': 'application/json' } },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(input));
  });
  expect(reboundStatus).toBe(403);
  expect((await post('/runs', input, { origin: 'null' })).status).toBe(403);
  expect((await post('/runs', input, { 'content-type': 'text/plain' })).status).toBe(415);
  expect((await post('/runs', input, { origin: base })).status).toBe(202);
});
it('rejects non-loopback listen addresses', () => {
  expect(() => createFactorydServer({ host: '0.0.0.0' })).toThrow('loopback');
});

it('advertises the per-run configuration contract before a worker dispatches work', async () => {
  const response = await fetch(`${base}/capabilities`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ capabilities: ['run.execution-config.v1'] });
});

it('advertises isolated lanes only when the configured runtime enables them', async () => {
  await server.stop();
  const registryFile = join(dir, 'registry.json');
  const runtime = await createRunRuntime({
    registryFile,
    allowParallel: true,
    execute: async () => ({ exitCode: 0, prUrl: null }),
  });
  server = createFactorydServer({ registryFile, port: 0, runRuntime: runtime, log: () => {} });
  base = `http://127.0.0.1:${await server.start()}`;
  expect(await (await fetch(`${base}/capabilities`)).json()).toEqual({
    capabilities: ['run.execution-config.v1', 'run.isolated-lanes.v1'],
  });
});

it('keeps legacy explicit run identities readable and never executes them again', async () => {
  const { daemonRunFile, writeDaemonRun } = await import('./run-store.js');
  const { daemonRuntimePaths } = await import('./runtime-state.js');
  const runId = randomUUID();
  const legacy = {
    runId,
    repo: 'test/repo',
    issue: 7,
    status: 'failed' as const,
    submittedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    detail: 'Prior execution failed',
  };
  await writeDaemonRun(daemonRunFile(daemonRuntimePaths(dir).runsDir, runId), legacy);
  expect(await (await fetch(`${base}/runs/${runId}`)).json()).toEqual({ run: legacy });
  expect(await (await post('/runs', { runId, repo: 'test/repo', issue: 7 })).json()).toEqual({ run: legacy });
});
