import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  acquirePidFile,
  createDaemonLogSink,
  daemonRuntimePaths,
  releaseRuntimeFiles,
  writePortFile,
} from './runtime-state.js';

const tmpDirs: string[] = [];

async function tmpPaths() {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-state-test-'));
  tmpDirs.push(dir);
  return daemonRuntimePaths(join(dir, 'state'));
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('daemonRuntimePaths', () => {
  it('defaults to <home>/.factory', () => {
    const paths = daemonRuntimePaths();
    expect(paths.dir).toBe(join(homedir(), '.factory'));
    expect(paths.pidFile).toBe(join(homedir(), '.factory', 'daemon.pid'));
  });

  it('resolves daemon.pid/daemon.port/daemon.log under an explicit dir', () => {
    const paths = daemonRuntimePaths('/tmp/x');
    expect(paths).toEqual({
      dir: '/tmp/x',
      pidFile: '/tmp/x/daemon.pid',
      portFile: '/tmp/x/daemon.port',
      logFile: '/tmp/x/daemon.log',
    });
  });
});

describe('acquirePidFile', () => {
  it('acquires a fresh dir, creating it and writing the own pid', async () => {
    const paths = await tmpPaths();
    const result = await acquirePidFile(paths, { pid: 4242 });
    expect(result).toEqual({ ok: true, stalePid: null });
    expect(await readFile(paths.pidFile, 'utf-8')).toBe('4242\n');
  });

  it('overwrites a stale (dead-pid) file and reports the displaced pid — SIGKILL never orphans the lock', async () => {
    const paths = await tmpPaths();
    await acquirePidFile(paths, { pid: 99999 });
    const result = await acquirePidFile(paths, { pid: 4242, isPidAlive: () => false });
    expect(result).toEqual({ ok: true, stalePid: 99999 });
    expect(await readFile(paths.pidFile, 'utf-8')).toBe('4242\n');
  });

  it('overwrites a garbage pid file and reports no stale pid', async () => {
    const paths = await tmpPaths();
    await acquirePidFile(paths, { pid: 1 });
    await writeFile(paths.pidFile, 'not-a-pid\n');
    const result = await acquirePidFile(paths, {
      pid: 4242,
      isPidAlive: () => {
        throw new Error('must not probe a garbage pid');
      },
    });
    expect(result).toEqual({ ok: true, stalePid: null });
    expect(await readFile(paths.pidFile, 'utf-8')).toBe('4242\n');
  });

  it('refuses when a live daemon holds the file and leaves the content untouched', async () => {
    const paths = await tmpPaths();
    await acquirePidFile(paths, { pid: 77 });
    const result = await acquirePidFile(paths, { pid: 4242, isPidAlive: () => true });
    expect(result).toEqual({ ok: false, holderPid: 77 });
    expect(await readFile(paths.pidFile, 'utf-8')).toBe('77\n');
  });

  it('defaults to process.pid, which is alive, so a second default acquire names it as holder', async () => {
    const paths = await tmpPaths();
    expect(await acquirePidFile(paths)).toEqual({ ok: true, stalePid: null });
    expect(await acquirePidFile(paths)).toEqual({ ok: false, holderPid: process.pid });
  });
});

describe('writePortFile', () => {
  it('writes parseable JSON { pid, port, host } with the loopback default host', async () => {
    const paths = await tmpPaths();
    await acquirePidFile(paths);
    await writePortFile(paths, 8787);
    expect(JSON.parse(await readFile(paths.portFile, 'utf-8'))).toEqual({
      pid: process.pid,
      port: 8787,
      host: '127.0.0.1',
    });
  });
});

describe('releaseRuntimeFiles', () => {
  it('removes pid and port files when the pid file records the caller', async () => {
    const paths = await tmpPaths();
    await acquirePidFile(paths, { pid: 4242 });
    await writePortFile(paths, 8787);
    await releaseRuntimeFiles(paths, { pid: 4242 });
    expect(existsSync(paths.pidFile)).toBe(false);
    expect(existsSync(paths.portFile)).toBe(false);
  });

  it("never deletes a successor daemon's files: a mismatched pid leaves both in place", async () => {
    const paths = await tmpPaths();
    await acquirePidFile(paths, { pid: 4242 });
    await writePortFile(paths, 8787);
    await releaseRuntimeFiles(paths, { pid: 1 });
    expect(existsSync(paths.pidFile)).toBe(true);
    expect(existsSync(paths.portFile)).toBe(true);
  });

  it('is a no-op when the files are absent', async () => {
    const paths = await tmpPaths();
    await expect(releaseRuntimeFiles(paths, { pid: 4242 })).resolves.toBeUndefined();
  });
});

describe('createDaemonLogSink', () => {
  it('appends ISO-timestamped lines, creating the parent dir on first use', async () => {
    const paths = await tmpPaths();
    const sink = createDaemonLogSink(paths.logFile, { now: () => new Date('2026-09-02T10:00:00.000Z') });
    sink('factoryd: listening on 127.0.0.1:8787');
    sink('GET /repos 200');
    expect(await readFile(paths.logFile, 'utf-8')).toBe(
      '2026-09-02T10:00:00.000Z factoryd: listening on 127.0.0.1:8787\n' + '2026-09-02T10:00:00.000Z GET /repos 200\n',
    );
  });

  it('swallows append errors instead of crashing the daemon', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-state-test-'));
    tmpDirs.push(dir);
    // A log path whose parent is a regular file makes both mkdir and append fail.
    await writeFile(join(dir, 'blocker'), '');
    const sink = createDaemonLogSink(join(dir, 'blocker', 'daemon.log'));
    expect(() => sink('line')).not.toThrow();
  });
});
