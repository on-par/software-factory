import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { writeRegistry } from './registry.js';
import { createRunRuntime, type RunRuntime } from './run-runtime.js';

let dir: string;
let registryFile: string;
let runtime: RunRuntime;
beforeEach(async () => {
  runtime = undefined!;
  dir = await mkdtemp(join(tmpdir(), 'factory-runs-'));
  registryFile = join(dir, 'registry.json');
  await writeRegistry(registryFile, {
    version: 1,
    repos: { 'test/repo': { path: dir, attachedAt: new Date().toISOString(), state: 'active' } },
  });
});
afterEach(async () => {
  await runtime?.stop();
  await rm(dir, { recursive: true, force: true });
});
it('persists an accepted run before execution and exposes its terminal result after reconnecting', async () => {
  let finish!: (value: { exitCode: number; prUrl: string }) => void;
  runtime = await createRunRuntime({
    registryFile,
    execute: async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const input = { runId: randomUUID(), repo: 'test/repo', issue: 42 };
  expect((await runtime.submit(input)).status).toBe('queued');
  await expect.poll(() => runtime.get(input.runId)?.status).toBe('running');
  finish({ exitCode: 0, prUrl: 'https://github.com/test/repo/pull/9' });
  await expect.poll(() => runtime.get(input.runId)?.status).toBe('succeeded');
  await runtime.stop();
  runtime = await createRunRuntime({
    registryFile,
    execute: async () => {
      throw new Error('must not rerun');
    },
  });
  expect(runtime.list()).toMatchObject([
    { ...input, status: 'succeeded', exitCode: 0, prUrl: 'https://github.com/test/repo/pull/9' },
  ]);
});
it('deduplicates concurrent submissions and rejects identity changes and duplicate issue runs', async () => {
  let launches = 0;
  runtime = await createRunRuntime({
    registryFile,
    execute: async ({ signal }) => {
      launches++;
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ exitCode: null, prUrl: null })));
    },
  });
  const input = { runId: randomUUID(), repo: 'test/repo', issue: 42 };
  const accepted = await Promise.all([runtime.submit(input), runtime.submit(input)]);
  expect(accepted.map((run) => run.runId)).toEqual([input.runId, input.runId]);
  await expect(runtime.submit({ ...input, issue: 43 })).rejects.toMatchObject({ status: 409 });
  await expect(runtime.submit({ ...input, runId: randomUUID() })).rejects.toMatchObject({ status: 409 });
  await expect.poll(() => launches).toBe(1);
  await runtime.cancel(input.runId);
  expect(runtime.get(input.runId)?.status).toBe('canceled');
});
it('keeps logs bounded, redacts credentials across chunks and persists them during execution', async () => {
  runtime = await createRunRuntime({
    registryFile,
    execute: async ({ signal, output }) => {
      output('x'.repeat(140_000));
      output('\u001b[31mAUTHORIZATION=sec');
      output('ret-value\n');
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ exitCode: null, prUrl: null })));
    },
  });
  const input = { runId: randomUUID(), repo: 'test/repo', issue: 1 };
  await runtime.submit(input);
  await expect.poll(() => runtime.logs(input.runId).text).toContain('[redacted]');
  const logs = runtime.logs(input.runId);
  expect(logs.truncated).toBe(true);
  expect(logs.text.length).toBeLessThanOrEqual(128 * 1024);
  expect(logs.text).not.toContain('secret-value');
  expect(logs.text).not.toContain('\u001b');
  const { readFile } = await import('node:fs/promises');
  await expect
    .poll(async () => JSON.parse(await readFile(join(dir, 'runs.json'), 'utf8'))[0].log, { timeout: 2500 })
    .toContain('[redacted]');
  expect(await readFile(join(dir, 'runs.json'), 'utf8')).not.toContain('secret-value');
});
it('runs queued issues one at a time and rechecks repository state before dispatch', async () => {
  const launched: number[] = [];
  let finish!: (result: { exitCode: number; prUrl: string | null }) => void;
  runtime = await createRunRuntime({
    registryFile,
    execute: async ({ run }) => {
      launched.push(run.issue);
      return new Promise((resolve) => (finish = resolve));
    },
  });
  const first = { runId: randomUUID(), repo: 'test/repo', issue: 1 };
  const second = { ...first, runId: randomUUID(), issue: 2 };
  await runtime.submit(first);
  await expect.poll(() => launched.length).toBe(1);
  await runtime.submit(second);
  expect(runtime.get(second.runId)?.status).toBe('queued');
  await writeRegistry(registryFile, { version: 1, repos: {} });
  finish({ exitCode: 1, prUrl: null });
  await expect.poll(() => runtime.get(second.runId)?.status).toBe('failed');
  expect(runtime.get(first.runId)?.exitCode).toBe(1);
  expect(launched).toEqual([1]);
});
it('cancels queued work without launching it and treats cancellation as idempotent', async () => {
  runtime = await createRunRuntime({
    registryFile,
    execute: async ({ signal }) =>
      new Promise((resolve) => signal.addEventListener('abort', () => resolve({ exitCode: null, prUrl: null }))),
  });
  const first = { runId: randomUUID(), repo: 'test/repo', issue: 1 };
  await runtime.submit(first);
  await expect.poll(() => runtime.get(first.runId)?.status).toBe('running');
  const second = await runtime.submit({ ...first, runId: randomUUID(), issue: 2 });
  expect((await runtime.cancel(second.runId)).status).toBe('canceled');
  expect((await runtime.cancel(second.runId)).status).toBe('canceled');
  expect(runtime.get(second.runId)?.startedAt).toBeNull();
  await expect(runtime.cancel('missing')).rejects.toMatchObject({ status: 404 });
  expect(() => runtime.logs('missing')).toThrow('Run not found');
});
it('stops active and queued work and rejects later submissions', async () => {
  runtime = await createRunRuntime({
    registryFile,
    execute: async ({ signal }) =>
      new Promise((resolve) => signal.addEventListener('abort', () => resolve({ exitCode: null, prUrl: null }))),
  });
  const first = { runId: randomUUID(), repo: 'test/repo', issue: 1 };
  await runtime.submit(first);
  await expect.poll(() => runtime.get(first.runId)?.status).toBe('running');
  await runtime.submit({ ...first, runId: randomUUID(), issue: 2 });
  await runtime.stop();
  expect(runtime.list().map((run) => run.status)).toEqual(['interrupted', 'interrupted']);
  await expect(runtime.submit({ ...first, runId: randomUUID(), issue: 3 })).rejects.toMatchObject({ status: 503 });
});
it.each([
  null,
  '',
  {},
  { runId: '../bad', repo: 'test/repo', issue: 1 },
  { runId: randomUUID(), repo: 'test/repo', issue: -1 },
  { runId: randomUUID(), repo: '/tmp/repo', issue: 1 },
  { runId: randomUUID(), repo: 'test/repo', issue: 1.2 },
])('rejects malformed commands without creating records: %j', async (input) => {
  runtime = await createRunRuntime({
    registryFile,
    execute: async () => {
      throw new Error('unexpected launch');
    },
  });
  await expect(runtime.submit(input)).rejects.toMatchObject({ status: 400 });
  expect(runtime.list()).toEqual([]);
});
it.each(['paused', 'detached', 'draining'] as const)('rejects an attached repository in %s state', async (state) => {
  await writeRegistry(registryFile, {
    version: 1,
    repos: { 'test/repo': { path: dir, state, attachedAt: new Date().toISOString() } },
  });
  runtime = await createRunRuntime({
    registryFile,
    execute: async () => {
      throw new Error('unexpected launch');
    },
  });
  await expect(runtime.submit({ runId: randomUUID(), repo: 'test/repo', issue: 1 })).rejects.toMatchObject({
    status: 409,
  });
});
it('fails closed on relocated factory state rather than using the wrong configuration', async () => {
  await writeRegistry(registryFile, {
    version: 1,
    repos: {
      'test/repo': { path: dir, state: 'active', stateRoot: '/other-state', attachedAt: new Date().toISOString() },
    },
  });
  runtime = await createRunRuntime({
    registryFile,
    execute: async () => {
      throw new Error('unexpected launch');
    },
  });
  await expect(runtime.submit({ runId: randomUUID(), repo: 'test/repo', issue: 1 })).rejects.toMatchObject({
    status: 409,
  });
});
it('records launch errors without leaking secrets and continues to the next issue', async () => {
  runtime = await createRunRuntime({
    registryFile,
    execute: async () => {
      throw new Error('failed with token=secret-value');
    },
  });
  const run = await runtime.submit({ runId: randomUUID(), repo: 'test/repo', issue: 1 });
  await expect.poll(() => runtime.get(run.runId)?.status).toBe('failed');
  expect(runtime.get(run.runId)?.summary).not.toContain('secret-value');
  const next = await runtime.submit({ runId: randomUUID(), repo: 'test/repo', issue: 2 });
  await expect.poll(() => runtime.get(next.runId)?.status).toBe('failed');
});
it('marks crash-surviving active records interrupted without dispatching them again', async () => {
  runtime = await createRunRuntime({ registryFile, execute: async () => ({ exitCode: 1, prUrl: null }) });
  const run = await runtime.submit({ runId: randomUUID(), repo: 'test/repo', issue: 1 });
  await expect.poll(() => runtime.get(run.runId)?.status).toBe('failed');
  await runtime.stop();
  const { readFile, writeFile } = await import('node:fs/promises');
  const file = join(dir, 'runs.json');
  const records = JSON.parse(await readFile(file, 'utf8'));
  records[0].run.status = 'running';
  await writeFile(file, JSON.stringify(records));
  runtime = await createRunRuntime({
    registryFile,
    execute: async () => {
      throw new Error('must not duplicate recovered run');
    },
  });
  expect(runtime.get(run.runId)?.status).toBe('interrupted');
  expect((await runtime.submit(run)).status).toBe('interrupted');
});
it('never overwrites a malformed durable store', async () => {
  const { writeFile, readFile } = await import('node:fs/promises');
  const file = join(dir, 'runs.json');
  const corrupt = JSON.stringify([
    {
      run: { status: 'running', summary: '', createdAt: new Date().toISOString(), issue: 1 },
      log: '',
      truncated: false,
    },
  ]);
  await writeFile(file, corrupt);
  await expect(
    createRunRuntime({ registryFile, execute: async () => ({ exitCode: 1, prUrl: null }) }),
  ).rejects.toThrow();
  expect(await readFile(file, 'utf8')).toBe(corrupt);
});
it('does not report cancellation complete until the executing process has settled', async () => {
  let settle!: (value: { exitCode: null; prUrl: null }) => void;
  let aborted = false;
  runtime = await createRunRuntime({
    registryFile,
    execute: async ({ signal }) => {
      signal.addEventListener('abort', () => (aborted = true));
      return new Promise((resolve) => (settle = resolve));
    },
  });
  const run = await runtime.submit({ runId: randomUUID(), repo: 'test/repo', issue: 1 });
  await expect.poll(() => runtime.isExecuting(run.repo)).toBe(true);
  const pending = runtime.cancel(run.runId);
  await expect.poll(() => aborted).toBe(true);
  try {
    expect(runtime.get(run.runId)?.status).toBe('running');
  } finally {
    settle({ exitCode: null, prUrl: null });
  }
  expect((await pending).status).toBe('canceled');
  expect(runtime.isExecuting(run.repo)).toBe(false);
});
it('does not start a command whose start deadline elapsed while queued', async () => {
  let finish!: () => void;
  let launches = 0;
  runtime = await createRunRuntime({
    registryFile,
    execute: async ({ signal }) => {
      launches++;
      return new Promise((resolve) => {
        finish = () => resolve({ exitCode: 1, prUrl: null });
        signal.addEventListener('abort', finish);
      });
    },
  });
  const first = await runtime.submit({ runId: randomUUID(), repo: 'test/repo', issue: 1 });
  await expect.poll(() => runtime.get(first.runId)?.status).toBe('running');
  const second = await runtime.submit({
    runId: randomUUID(),
    repo: 'test/repo',
    issue: 2,
    expiresAt: new Date(0).toISOString(),
  });
  finish();
  await expect.poll(() => runtime.get(second.runId)?.status).toBe('failed');
  expect(runtime.get(second.runId)?.summary).toContain('expired');
  expect(launches).toBe(1);
});
it('never launches a command when the atomic acceptance write fails', async () => {
  const { mkdir } = await import('node:fs/promises');
  let launches = 0;
  runtime = await createRunRuntime({
    registryFile,
    execute: async () => {
      launches++;
      return { exitCode: 1, prUrl: null };
    },
  });
  const pendingFile = join(dir, 'runs.json.tmp');
  await mkdir(pendingFile);
  try {
    await expect(runtime.submit({ runId: randomUUID(), repo: 'test/repo', issue: 1 })).rejects.toThrow();
    expect(runtime.list()).toEqual([]);
    expect(launches).toBe(0);
  } finally {
    await rm(pendingFile, { recursive: true });
  }
});
it('still terminates execution when shutdown cannot persist its status', async () => {
  const { mkdir } = await import('node:fs/promises');
  runtime = await createRunRuntime({
    registryFile,
    execute: async ({ signal }) =>
      new Promise((resolve) => signal.addEventListener('abort', () => resolve({ exitCode: null, prUrl: null }))),
  });
  const run = await runtime.submit({ runId: randomUUID(), repo: 'test/repo', issue: 1 });
  await expect.poll(() => runtime.isExecuting(run.repo)).toBe(true);
  const pendingFile = join(dir, 'runs.json.tmp');
  await mkdir(pendingFile);
  try {
    await expect(runtime.stop()).rejects.toThrow();
    expect(runtime.isExecuting(run.repo)).toBe(false);
  } finally {
    await rm(pendingFile, { recursive: true });
  }
});
it('executes a real installed CLI through durable ownership and releases it after a successful PR', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { createShipExecutor } = await import('./ship-executor.js');
  const cliEntrypoint = join(dir, 'cli.mjs');
  await writeFile(
    cliEntrypoint,
    `import { appendFileSync, mkdirSync } from 'node:fs'; import { dirname } from 'node:path'; mkdirSync(dirname(process.env.FACTORY_DAEMON_GROUPS_FILE), {recursive:true}); appendFileSync(process.env.FACTORY_DAEMON_GROUPS_FILE, String(process.pid) + '\\n'); console.log('✅ Issue #42 → PR #91 ready for review');`,
  );
  runtime = await createRunRuntime({ registryFile, execute: createShipExecutor({ cliEntrypoint }) });
  const run = await runtime.submit({ runId: randomUUID(), repo: 'test/repo', issue: 42 });
  await expect.poll(() => runtime.get(run.runId)?.status, { timeout: 3000 }).toBe('succeeded');
  expect(runtime.get(run.runId)?.prUrl).toBe('https://github.com/test/repo/pull/91');
  const { access } = await import('node:fs/promises');
  await expect(access(join(dir, 'run-groups', `${run.runId}.ndjson`))).rejects.toMatchObject({ code: 'ENOENT' });
  const next = await runtime.submit({ runId: randomUUID(), repo: 'test/repo', issue: 43 });
  await expect.poll(() => runtime.get(next.runId)?.status, { timeout: 3000 }).toBe('failed');
});
it('retires recovered process identities only after observing that every owner has stopped', async () => {
  const { spawn } = await import('node:child_process');
  const { readFile, writeFile } = await import('node:fs/promises');
  const { recordOwnedProcess } = await import('./process-ownership.js');
  runtime = await createRunRuntime({ registryFile, execute: async () => ({ exitCode: 1, prUrl: null }) });
  const run = await runtime.submit({ runId: randomUUID(), repo: 'test/repo', issue: 1 });
  await expect.poll(() => runtime.get(run.runId)?.status).toBe('failed');
  await runtime.stop();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await new Promise((resolve) => child.once('spawn', resolve));
  const records = JSON.parse(await readFile(join(dir, 'runs.json'), 'utf8'));
  records[0].executionPid = child.pid;
  recordOwnedProcess(join(dir, 'run-groups', `${run.runId}.ndjson`), child.pid!);
  await writeFile(join(dir, 'runs.json'), JSON.stringify(records));
  runtime = await createRunRuntime({ registryFile, execute: async () => ({ exitCode: 1, prUrl: null }) });
  try {
    await expect(runtime.submit({ ...run, runId: randomUUID() })).rejects.toMatchObject({ status: 409 });
  } finally {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  await runtime.submit(run);
  expect(JSON.parse(await readFile(join(dir, 'runs.json'), 'utf8'))[0].executionPid).toBeUndefined();
  const { access } = await import('node:fs/promises');
  await expect(access(join(dir, 'run-groups', `${run.runId}.ndjson`))).rejects.toMatchObject({ code: 'ENOENT' });
});
