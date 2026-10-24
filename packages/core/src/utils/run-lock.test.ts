import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { workKeyFromIssue } from '../work/work-key.js';
import {
  listLiveRunLocks,
  readRunLockHolder,
  RunLockHeldError,
  runLockDirFor,
  withRunLock,
  withScopedRunLock,
} from './run-lock.js';

describe('withRunLock / readRunLockHolder', () => {
  const tmpRoots: string[] = [];

  const makeLockDir = () => {
    const root = mkdtempSync(join(tmpdir(), 'run-lock-'));
    tmpRoots.push(root);
    return join(root, 'run.lock');
  };

  afterEach(() => {
    for (const root of tmpRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs fn and removes the lock dir afterwards', async () => {
    const lockDir = makeLockDir();

    const result = await withRunLock(lockDir, async () => 'ok');

    expect(result).toBe('ok');
    expect(existsSync(lockDir)).toBe(false);
  });

  it('writes holder metadata while held', async () => {
    const lockDir = makeLockDir();
    const now = () => new Date('2026-01-02T03:04:05.000Z');
    const hostnameFn = () => 'lane-host';

    await withRunLock(
      lockDir,
      async () => {
        const holder = readRunLockHolder(lockDir);
        expect(holder).toEqual({
          pid: process.pid,
          command: 'factory run',
          startedAt: '2026-01-02T03:04:05.000Z',
          host: 'lane-host',
        });
      },
      { command: 'factory run', now, hostnameFn },
    );
  });

  it('refuses a live holder without touching the pre-existing lock', async () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '4321');
    writeFileSync(join(lockDir, 'meta.json'), JSON.stringify({ command: 'factory run', host: 'other-host' }));
    const fn = vi.fn();

    let rejection: unknown;
    try {
      await withRunLock(lockDir, fn, { isPidAlive: () => true });
    } catch (err) {
      rejection = err;
    }

    expect(rejection).toBeInstanceOf(RunLockHeldError);
    const held = rejection as RunLockHeldError;
    expect(held.message).toContain('4321');
    expect(held.message).toContain(lockDir);
    expect(held.lockDir).toBe(lockDir);
    expect(held.holder).toEqual({ pid: 4321, command: 'factory run', host: 'other-host' });

    expect(fn).not.toHaveBeenCalled();
    expect(readFileSync(join(lockDir, 'pid'), 'utf-8')).toBe('4321');
  });

  it('reclaims a dead holder', async () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '4321');
    writeFileSync(join(lockDir, 'meta.json'), JSON.stringify({ command: 'factory run' }));
    const onReclaim = vi.fn();
    let ran = false;

    await withRunLock(
      lockDir,
      async () => {
        ran = true;
      },
      { isPidAlive: () => false, onReclaim },
    );

    expect(ran).toBe(true);
    expect(onReclaim).toHaveBeenCalledWith(4321);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('propagates a fn() error carrying reason "timeout" unchanged, never reclassifying it as a lock conflict', async () => {
    const lockDir = makeLockDir();
    const timeoutErr = Object.assign(new Error('provider timed out'), { reason: 'timeout' });

    let rejection: unknown;
    try {
      await withRunLock(lockDir, async () => {
        throw timeoutErr;
      });
    } catch (err) {
      rejection = err;
    }

    expect(rejection).toBe(timeoutErr);
    expect(rejection).not.toBeInstanceOf(RunLockHeldError);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('releases the lock when fn throws, and a subsequent call succeeds', async () => {
    const lockDir = makeLockDir();

    await expect(
      withRunLock(lockDir, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(
      withRunLock(lockDir, async () => {
        throw new Error('boom');
      }),
    ).rejects.not.toBeInstanceOf(RunLockHeldError);

    expect(existsSync(lockDir)).toBe(false);

    let ran = false;
    await withRunLock(lockDir, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('is reentrant within one process', async () => {
    const lockDir = makeLockDir();
    let innerRan = false;

    await withRunLock(lockDir, async () => {
      await withRunLock(lockDir, async () => {
        innerRan = true;
      });
    });

    expect(innerRan).toBe(true);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('readRunLockHolder degrades corrupt meta.json to a pid-only holder', () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '777');
    writeFileSync(join(lockDir, 'meta.json'), '{oops');

    expect(readRunLockHolder(lockDir)).toEqual({ pid: 777 });
  });

  it('readRunLockHolder returns null with no pid file or a non-existent dir', () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);

    expect(readRunLockHolder(lockDir)).toBeNull();
    expect(readRunLockHolder(join(lockDir, 'nope'))).toBeNull();
  });

  it('reclaims a stale lock with an unreadable pid past the grace window', async () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), 'not-a-pid');
    const past = new Date(Date.now() - 1_000);
    utimesSync(lockDir, past, past);
    let ran = false;

    await withRunLock(
      lockDir,
      async () => {
        ran = true;
      },
      { graceMs: 10, staleRetryMs: 200, pollMs: 10 },
    );

    expect(ran).toBe(true);
  });
});

describe('withScopedRunLock', () => {
  const tempDirs = createTempDirs();
  const otherPid = process.pid + 1;
  const keyA = workKeyFromIssue(1);
  const keyB = workKeyFromIssue(2);

  const makePaths = () => {
    const root = tempDirs.makeSync('scoped-run-lock-');
    return { runLock: join(root, 'run.lock'), runLocks: join(root, 'locks', 'run') };
  };

  const fakeHolder = (dir: string, pid: number) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pid'), `${pid}\n`);
  };

  afterEach(() => tempDirs.cleanup());

  it('lets issue B acquire while issue A is held by a live holder', async () => {
    const paths = makePaths();
    fakeHolder(runLockDirFor(paths, { kind: 'issue', key: keyA }), otherPid);

    const result = await withScopedRunLock(paths, { kind: 'issue', key: keyB }, async () => 'ran', {
      isPidAlive: () => true,
    });

    expect(result).toBe('ran');
  });

  it('refuses a second live holder of the same issue with RunLockHeldError naming locks/run/<key>', async () => {
    const paths = makePaths();
    const dir = runLockDirFor(paths, { kind: 'issue', key: keyA });
    fakeHolder(dir, otherPid);

    const err = await withScopedRunLock(paths, { kind: 'issue', key: keyA }, async () => 'ran', {
      isPidAlive: () => true,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RunLockHeldError);
    expect((err as RunLockHeldError).lockDir).toBe(dir);
    expect(dir).toContain(join('locks', 'run', keyA));
  });

  it('reclaims a dead-pid issue lock and calls onReclaim', async () => {
    const paths = makePaths();
    fakeHolder(runLockDirFor(paths, { kind: 'issue', key: keyA }), otherPid);
    const onReclaim = vi.fn();

    const result = await withScopedRunLock(paths, { kind: 'issue', key: keyA }, async () => 'ran', {
      isPidAlive: (pid) => pid === process.pid,
      onReclaim,
    });

    expect(result).toBe('ran');
    expect(onReclaim).toHaveBeenCalledWith(otherPid);
  });

  it('nested checkout-scope acquire in one process is a pass-through and the cross-check ignores own pid', async () => {
    const paths = makePaths();
    const scope = { kind: 'checkout' } as const;
    const issueDir = runLockDirFor(paths, { kind: 'issue', key: keyA });
    fakeHolder(issueDir, process.pid);

    const result = await withScopedRunLock(paths, scope, () => withScopedRunLock(paths, scope, async () => 'nested'), {
      isPidAlive: () => true,
    });

    expect(result).toBe('nested');
  });

  it('refuses an issue-scope acquire while a live checkout-scope holder exists, and refuses checkout scope while a live issue lock exists', async () => {
    const paths = makePaths();
    const opts = { isPidAlive: () => true };
    const issueScope = { kind: 'issue', key: keyA } as const;

    fakeHolder(paths.runLock, otherPid);
    const issueErr = await withScopedRunLock(paths, issueScope, async () => 'ran', opts).catch((e: unknown) => e);
    expect(issueErr).toBeInstanceOf(RunLockHeldError);
    expect((issueErr as RunLockHeldError).lockDir).toBe(paths.runLock);
    expect(existsSync(runLockDirFor(paths, issueScope))).toBe(false);
    rmSync(paths.runLock, { recursive: true });

    fakeHolder(runLockDirFor(paths, { kind: 'issue', key: keyB }), otherPid);
    const checkoutErr = await withScopedRunLock(paths, { kind: 'checkout' }, async () => 'ran', opts).catch(
      (e: unknown) => e,
    );
    expect(checkoutErr).toBeInstanceOf(RunLockHeldError);
    expect((checkoutErr as RunLockHeldError).lockDir).toBe(runLockDirFor(paths, { kind: 'issue', key: keyB }));
    expect(existsSync(paths.runLock)).toBe(false);
  });

  it('listLiveRunLocks skips a missing locks dir, dead holders and non-directory entries', () => {
    const paths = makePaths();
    expect(listLiveRunLocks(paths, () => true)).toEqual([]);

    fakeHolder(paths.runLock, otherPid);
    expect(listLiveRunLocks(paths, () => true).map((l) => l.lockDir)).toEqual([paths.runLock]);

    const liveDir = runLockDirFor(paths, { kind: 'issue', key: keyA });
    const deadDir = runLockDirFor(paths, { kind: 'issue', key: keyB });
    fakeHolder(liveDir, otherPid);
    fakeHolder(deadDir, otherPid + 1);
    writeFileSync(join(paths.runLocks, 'stray-file'), 'x');

    const live = listLiveRunLocks(paths, (pid) => pid === otherPid).map((l) => l.lockDir);
    expect(live).toEqual([paths.runLock, liveDir]);
  });
});
