import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDaemonLaneContext } from './lane-context.js';
import { daemonRunFile, MAX_DETAIL_CHARS, readDaemonRun, type DaemonRunRecord } from './run-store.js';
import type { RepoRegistry } from './registry.js';
import { executeDaemonRun, submitDaemonRun } from './runs-submit.js';

const dirs: string[] = [];
async function setup(state = 'active'): Promise<{ dir: string; registryFile: string; runsDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'runs-submit-'));
  dirs.push(dir);
  const registryFile = join(dir, 'registry.json');
  const registry: RepoRegistry = {
    version: 1,
    repos: { 'owner/repo': { path: '/repo', attachedAt: 't', state: state as 'active' } },
  };
  await writeFile(registryFile, JSON.stringify(registry));
  return { dir, registryFile, runsDir: join(dir, 'runs') };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const now = () => new Date('2026-01-01T00:00:00.000Z');

describe('submitDaemonRun', () => {
  it.each([
    null,
    [],
    {},
    { runId: '../x', repo: 'owner/repo', issue: 1 },
    { runId: 'R', repo: 'bad', issue: 1 },
    { runId: 'R', repo: 'owner/repo', issue: 0 },
    { runId: 'R', repo: 'owner/repo', issue: 1.5 },
    { runId: 'R', repo: 'owner/repo', issue: 'x' },
  ])('rejects invalid body %# without creating runs', async (body) => {
    const { registryFile, runsDir } = await setup();
    await expect(submitDaemonRun(registryFile, runsDir, body)).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-request',
    });
    await expect(readdir(runsDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('gates unknown and inactive repos', async () => {
    const a = await setup();
    await expect(
      submitDaemonRun(a.registryFile, a.runsDir, { runId: 'R', repo: 'none/x', issue: 1 }),
    ).resolves.toMatchObject({ reason: 'unknown-repo' });
    for (const state of ['paused', 'draining', 'detached']) {
      const b = await setup(state);
      await expect(
        submitDaemonRun(b.registryFile, b.runsDir, { runId: 'R', repo: 'owner/repo', issue: 1 }),
      ).resolves.toMatchObject({ reason: 'repo-not-dispatchable', detail: expect.stringContaining(state) });
    }
  });
  it('creates, replays without registry access, and fences concurrent submits', async () => {
    const { registryFile, runsDir } = await setup();
    const body = { runId: 'R', repo: 'owner/repo', issue: 7 };
    const first = await submitDaemonRun(registryFile, runsDir, body, { now });
    expect(first).toMatchObject({
      ok: true,
      created: true,
      run: { status: 'queued', submittedAt: now().toISOString() },
    });
    const replay = await submitDaemonRun(join(runsDir, 'missing'), runsDir, body);
    expect(replay).toMatchObject({ ok: true, created: false, run: first.ok ? first.run : undefined });
    const c = await setup();
    const results = await Promise.all([
      submitDaemonRun(c.registryFile, c.runsDir, body),
      submitDaemonRun(c.registryFile, c.runsDir, body),
    ]);
    expect(results.filter((r) => r.ok && r.created)).toHaveLength(1);
    expect(await readdir(c.runsDir)).toEqual(['R.json']);
  });
  it('does not overwrite an unreadable claimed record', async () => {
    const { registryFile, runsDir } = await setup();
    const file = daemonRunFile(runsDir, 'R');
    await mkdir(runsDir, { recursive: true });
    await writeFile(file, 'garbage');
    await expect(
      submitDaemonRun(registryFile, runsDir, { runId: 'R', repo: 'owner/repo', issue: 1 }),
    ).resolves.toMatchObject({ reason: 'unreadable-run-record' });
    expect(await readFile(file, 'utf-8')).toBe('garbage');
  });
  it('transitions successful and failed runs without throwing on storage failure', async () => {
    const { registryFile, runsDir } = await setup();
    const submitted = await submitDaemonRun(
      registryFile,
      runsDir,
      { runId: 'R', repo: 'owner/repo', issue: 1 },
      { now },
    );
    if (!submitted.ok || !submitted.created) throw new Error('setup');
    const context = createDaemonLaneContext(submitted.entry);
    let seen: DaemonRunRecord | undefined;
    const done = await executeDaemonRun(
      runsDir,
      submitted.run,
      context,
      async (run, received) => {
        seen = run;
        expect(received.repoRoot).toBe('/repo');
      },
      { now },
    );
    expect(seen?.status).toBe('running');
    expect(done.status).toBe('succeeded');
    expect(await readDaemonRun(daemonRunFile(runsDir, 'R'))).toEqual(done);
    const failed = await executeDaemonRun(
      runsDir,
      submitted.run,
      context,
      async () => {
        throw new Error('x'.repeat(MAX_DETAIL_CHARS + 1));
      },
      { now },
    );
    expect(failed.detail).toMatch(/…$/);
    const logs: string[] = [];
    const bad = await executeDaemonRun(
      join(registryFile, 'runs'),
      submitted.run,
      context,
      async () => {
        throw 'plain string';
      },
      { log: (line) => logs.push(line) },
    );
    expect(bad).toMatchObject({ status: 'failed', detail: 'plain string' });
    expect(logs.length).toBeGreaterThan(0);
  });
});
