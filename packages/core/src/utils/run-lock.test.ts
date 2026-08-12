import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readRunLockHolder, RunLockHeldError, withRunLock } from './run-lock.js';

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
