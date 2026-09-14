import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createRunRuntime } from './run-runtime.js';
import { writeRegistry } from './registry.js';

it('executes different lanes concurrently, serializes each lane and cancels only the selected delivery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'daemon-lanes-'));
  const registryFile = join(dir, 'registry.json');
  await writeRegistry(registryFile, {
    version: 1,
    repos: { 'owner/repo': { path: dir, attachedAt: new Date().toISOString(), state: 'active' } },
  });
  const started: number[] = [];
  const finish = new Map<number, () => void>();
  const runtime = await createRunRuntime({
    registryFile,
    allowParallel: true,
    execute: async ({ run, signal }) => {
      started.push(run.issue);
      await new Promise<void>((resolve) => {
        finish.set(run.issue, resolve);
        signal.addEventListener('abort', () => resolve());
      });
      return { exitCode: 0, prUrl: 'https://github.com/owner/repo/pull/1' };
    },
  });
  try {
    const a = await runtime.submit({ runId: randomUUID(), repo: 'owner/repo', issue: 1, laneId: 1 });
    await runtime.submit({ runId: randomUUID(), repo: 'owner/repo', issue: 2, laneId: 1 });
    const b = await runtime.submit({ runId: randomUUID(), repo: 'owner/repo', issue: 3, laneId: 2 });
    await expect.poll(() => started).toEqual([1, 3]);
    await runtime.cancel(a.runId);
    await expect.poll(() => started).toEqual([1, 3, 2]);
    expect(runtime.get(a.runId)?.status).toBe('canceled');
    expect(runtime.get(b.runId)?.status).toBe('running');
    finish.get(3)!();
    await expect.poll(() => runtime.get(b.runId)?.status).toBe('succeeded');
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

it('runs two real CLI processes in isolated worktrees and retains state across daemon recovery', async () => {
  const { execa } = await import('execa');
  const { writeFile } = await import('node:fs/promises');
  const { createShipExecutor } = await import('./ship-executor.js');
  const dir = await mkdtemp(join(tmpdir(), 'daemon-lane-processes-'));
  const registryFile = join(dir, 'registry.json');
  await execa('git', ['init', '-b', 'main'], { cwd: dir });
  await execa(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'base'],
    { cwd: dir },
  );
  await writeRegistry(registryFile, {
    version: 1,
    repos: { 'owner/repo': { path: dir, attachedAt: new Date().toISOString(), state: 'active' } },
  });
  const cliEntrypoint = join(dir, 'probe.mjs');
  await writeFile(
    cliEntrypoint,
    'console.log(JSON.stringify({cwd:process.cwd(),branch:process.env.FACTORY_BRANCH_PREFIX})); setInterval(()=>{},1000);',
  );
  const execute = createShipExecutor({ cliEntrypoint, terminationGraceMs: 50 });
  const runtime = await createRunRuntime({ registryFile, allowParallel: true, execute });
  try {
    const a = await runtime.submit({ runId: randomUUID(), repo: 'owner/repo', issue: 1, laneId: 1 });
    const b = await runtime.submit({ runId: randomUUID(), repo: 'owner/repo', issue: 2, laneId: 2 });
    await expect.poll(() => runtime.logs(a.runId).text, { timeout: 5000 }).toContain('cwd');
    await expect.poll(() => runtime.logs(b.runId).text, { timeout: 5000 }).toContain('cwd');
    const first = JSON.parse(runtime.logs(a.runId).text);
    const second = JSON.parse(runtime.logs(b.runId).text);
    expect(first.cwd).not.toBe(second.cwd);
    expect(first.branch).not.toBe(second.branch);
    expect((await execa('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: dir })).stdout).toBe('');
    await runtime.cancel(a.runId);
    expect(runtime.get(b.runId)?.status).toBe('running');
    await runtime.stop();
    const recovered = await createRunRuntime({ registryFile, allowParallel: true, execute });
    try {
      expect(recovered.get(a.runId)).toMatchObject({ status: 'canceled', laneId: 1 });
      expect(recovered.get(b.runId)).toMatchObject({ status: 'interrupted', laneId: 2 });
    } finally {
      await recovered.stop();
    }
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
