import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { withFileLock, withFileLockSync, withGitLock } from './lock.js';

const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe('withGitLock', () => {
  it('serializes work for the same key', async () => {
    const key = 'same-key';
    const order: string[] = [];
    let active = 0;
    let peakActive = 0;

    const first = withGitLock(key, async () => {
      active++;
      peakActive = Math.max(peakActive, active);
      order.push('first:start');
      await delay();
      order.push('first:end');
      active--;
    });

    const second = withGitLock(key, async () => {
      active++;
      peakActive = Math.max(peakActive, active);
      order.push('second:start');
      await delay();
      order.push('second:end');
      active--;
    });

    await Promise.all([first, second]);

    expect(peakActive).toBe(1);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('releases the lock when work throws', async () => {
    const key = 'throw-key';

    await expect(
      withGitLock(key, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    let ran = false;
    await expect(
      withGitLock(key, async () => {
        ran = true;
        return 'ok';
      }),
    ).resolves.toBe('ok');

    expect(ran).toBe(true);
  });

  it('allows different keys to run concurrently', async () => {
    let active = 0;
    let peakActive = 0;

    const run = async () => {
      active++;
      peakActive = Math.max(peakActive, active);
      await delay();
      active--;
    };

    await Promise.all([withGitLock('key-a', run), withGitLock('key-b', run)]);

    expect(peakActive).toBe(2);
  });
});

describe('withFileLock', () => {
  const tmpRoots: string[] = [];

  const makeLockDir = () => {
    const root = mkdtempSync(join(tmpdir(), 'lock-'));
    tmpRoots.push(root);
    return join(root, 'test.lock');
  };

  afterEach(() => {
    for (const root of tmpRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('acquires when free and releases after resolve or reject', async () => {
    const lockDir = makeLockDir();

    await withFileLock(lockDir, async () => {
      expect(readFileSync(join(lockDir, 'pid'), 'utf-8')).toBe(String(process.pid));
      return 'ok';
    });

    expect(existsSync(lockDir)).toBe(false);

    await expect(
      withFileLock(lockDir, async () => {
        expect(readFileSync(join(lockDir, 'pid'), 'utf-8')).toBe(String(process.pid));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(existsSync(lockDir)).toBe(false);
  });

  it('propagates an fn() error carrying an EEXIST code instead of swallowing and retrying', async () => {
    const lockDir = makeLockDir();
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('caller EEXIST'), { code: 'EEXIST' });
    });

    await expect(withFileLock(lockDir, fn)).rejects.toThrow('caller EEXIST');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('steals from a dead holder', async () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '999999');
    const onSteal = vi.fn();
    let ran = false;

    await withFileLock(
      lockDir,
      async () => {
        ran = true;
      },
      { pollMs: 10, timeoutMs: 100, isPidAlive: () => false, onSteal },
    );

    expect(ran).toBe(true);
    expect(onSteal).toHaveBeenCalledWith(999999);
  });

  it('waits while the holder is alive', async () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '12345');
    const onSteal = vi.fn();
    let removed = false;

    const timer = setTimeout(() => {
      removed = true;
      rmSync(lockDir, { recursive: true, force: true });
    }, 50);

    try {
      await withFileLock(
        lockDir,
        async () => {
          expect(removed).toBe(true);
        },
        { pollMs: 10, timeoutMs: 500, isPidAlive: () => true, onSteal },
      );
    } finally {
      clearTimeout(timer);
    }

    expect(onSteal).not.toHaveBeenCalled();
  });

  it('times out on a live holder', async () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '12345');
    const fn = vi.fn();

    await expect(
      withFileLock(lockDir, fn, {
        pollMs: 10,
        timeoutMs: 50,
        isPidAlive: () => true,
      }),
    ).rejects.toThrow(/stuck/);

    expect(fn).not.toHaveBeenCalled();
  });

  it('tags the timeout error with reason "timeout" so callers can distinguish it from a plain failure', async () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '12345');

    await expect(
      withFileLock(lockDir, vi.fn(), {
        pollMs: 10,
        timeoutMs: 50,
        isPidAlive: () => true,
      }),
    ).rejects.toMatchObject({ reason: 'timeout' });
  });

  it('steals an orphan dir with no pid file', async () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    const past = new Date(Date.now() - 1_000);
    utimesSync(lockDir, past, past);
    const onSteal = vi.fn();
    let ran = false;

    await withFileLock(
      lockDir,
      async () => {
        ran = true;
      },
      { pollMs: 10, timeoutMs: 100, graceMs: 10, onSteal },
    );

    expect(ran).toBe(true);
    expect(onSteal).toHaveBeenCalledWith(null);
  });

  it('does not steal a fresh dir with no pid file inside the grace window', async () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    const onSteal = vi.fn();
    const fn = vi.fn();

    await expect(
      withFileLock(lockDir, fn, {
        pollMs: 10,
        timeoutMs: 80,
        graceMs: 10_000,
        onSteal,
      }),
    ).rejects.toThrow(/stuck/);

    expect(fn).not.toHaveBeenCalled();
    expect(onSteal).not.toHaveBeenCalled();
  });

  it('defaultIsPidAlive: treats our own live pid as alive, so acquisition times out', async () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), String(process.pid));
    const fn = vi.fn();

    await expect(withFileLock(lockDir, fn, { pollMs: 10, timeoutMs: 50 })).rejects.toThrow(/stuck/);

    expect(fn).not.toHaveBeenCalled();
  });

  it('defaultIsPidAlive: treats a dead pid as not alive, so it steals after grace', async () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    writeFileSync(join(lockDir, 'pid'), String(dead.pid));
    let ran = false;

    await withFileLock(
      lockDir,
      async () => {
        ran = true;
      },
      { pollMs: 10, timeoutMs: 200, graceMs: 10 },
    );

    expect(ran).toBe(true);
  });

  it('treats an unparseable pid file as orphaned and steals it once stale (also covers the no-onSteal arm)', async () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), 'abc');
    const past = new Date(Date.now() - 1_000);
    utimesSync(lockDir, past, past);
    let ran = false;

    await withFileLock(
      lockDir,
      async () => {
        ran = true;
      },
      { pollMs: 10, timeoutMs: 100, graceMs: 10 },
    );

    expect(ran).toBe(true);
  });

  it('steals a dead holder without an onSteal callback', async () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '999999');
    let ran = false;

    await withFileLock(
      lockDir,
      async () => {
        ran = true;
      },
      { pollMs: 10, timeoutMs: 100, isPidAlive: () => false },
    );

    expect(ran).toBe(true);
  });

  it('rethrows a non-EEXIST error from mkdirSync(lockDir)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'lock-'));
    tmpRoots.push(parent);
    const lockDir = join(parent, 'test.lock');
    chmodSync(parent, 0o555);

    try {
      await expect(withFileLock(lockDir, vi.fn())).rejects.toThrow();
    } finally {
      chmodSync(parent, 0o755);
    }
  });

  it('skips lock dir cleanup when the pid file no longer matches this process on the way out', async () => {
    const lockDir = makeLockDir();

    await withFileLock(lockDir, async () => {
      writeFileSync(join(lockDir, 'pid'), '999999');
    });

    expect(existsSync(lockDir)).toBe(true);
  });

  it('does not delete a live lock when the observed dead holder was replaced mid-steal (#597)', async () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '999999');
    const onSteal = vi.fn();
    const fn = vi.fn();

    let calls = 0;
    const isPidAlive = vi.fn(() => {
      calls++;
      if (calls === 1) {
        rmSync(lockDir, { recursive: true, force: true });
        mkdirSync(lockDir);
        writeFileSync(join(lockDir, 'pid'), '4242');
        return false;
      }
      return true;
    });

    await expect(withFileLock(lockDir, fn, { pollMs: 10, timeoutMs: 50, isPidAlive, onSteal })).rejects.toThrow(
      /stuck/,
    );

    expect(fn).not.toHaveBeenCalled();
    expect(onSteal).not.toHaveBeenCalled();
    expect(existsSync(lockDir)).toBe(true);
    expect(readFileSync(join(lockDir, 'pid'), 'utf-8')).toBe('4242');
  });

  it('re-observes and steals on the next pass when the stale dir was recreated with the same pid', async () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '999999');
    const onSteal = vi.fn();
    let ran = false;

    let calls = 0;
    const isPidAlive = vi.fn(() => {
      calls++;
      if (calls === 1) {
        rmSync(lockDir, { recursive: true, force: true });
        mkdirSync(lockDir);
        writeFileSync(join(lockDir, 'pid'), '999999');
        const past = new Date(Date.now() - 1_000);
        utimesSync(lockDir, past, past);
      }
      return false;
    });

    await withFileLock(
      lockDir,
      async () => {
        ran = true;
      },
      { pollMs: 10, timeoutMs: 500, graceMs: 10, isPidAlive, onSteal },
    );

    expect(ran).toBe(true);
    expect(onSteal).toHaveBeenCalledTimes(1);
    expect(onSteal).toHaveBeenCalledWith(999999);
  });

  it('backs off instead of stealing while another stealer holds the steal arbiter', async () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '999999');
    mkdirSync(`${lockDir}.steal`);
    const onSteal = vi.fn();
    const fn = vi.fn();

    await expect(
      withFileLock(lockDir, fn, {
        pollMs: 10,
        timeoutMs: 50,
        graceMs: 10_000,
        isPidAlive: () => false,
        onSteal,
      }),
    ).rejects.toThrow(/stuck/);

    expect(fn).not.toHaveBeenCalled();
    expect(onSteal).not.toHaveBeenCalled();
    expect(existsSync(lockDir)).toBe(true);
    expect(existsSync(`${lockDir}.steal`)).toBe(true);
  });

  it('reaps a steal arbiter left behind by a dead stealer, then steals', async () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '999999');
    mkdirSync(`${lockDir}.steal`);
    const past = new Date(Date.now() - 1_000);
    utimesSync(`${lockDir}.steal`, past, past);
    const onSteal = vi.fn();
    let ran = false;

    await withFileLock(
      lockDir,
      async () => {
        ran = true;
      },
      { pollMs: 10, timeoutMs: 500, graceMs: 10, isPidAlive: () => false, onSteal },
    );

    expect(ran).toBe(true);
    expect(onSteal).toHaveBeenCalledWith(999999);
    expect(existsSync(`${lockDir}.steal`)).toBe(false);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('retries without stealing when the lock dir disappears during the steal', async () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '999999');
    const onSteal = vi.fn();
    let ran = false;

    let calls = 0;
    const isPidAlive = vi.fn(() => {
      calls++;
      if (calls === 1) {
        rmSync(lockDir, { recursive: true, force: true });
      }
      return false;
    });

    await withFileLock(
      lockDir,
      async () => {
        ran = true;
      },
      { pollMs: 10, timeoutMs: 200, isPidAlive, onSteal },
    );

    expect(ran).toBe(true);
    expect(onSteal).not.toHaveBeenCalled();
  });
});

describe('withFileLockSync', () => {
  const tmpRoots: string[] = [];

  const makeLockDir = () => {
    const root = mkdtempSync(join(tmpdir(), 'lock-sync-'));
    tmpRoots.push(root);
    return join(root, 'test.lock');
  };

  afterEach(() => {
    for (const root of tmpRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns fn()s value and removes the lock dir afterwards', () => {
    const lockDir = makeLockDir();

    const result = withFileLockSync(lockDir, () => {
      expect(readFileSync(join(lockDir, 'pid'), 'utf-8')).toBe(String(process.pid));
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(existsSync(lockDir)).toBe(false);
  });

  it('releases the lock when fn throws, and rethrows', () => {
    const lockDir = makeLockDir();

    expect(() =>
      withFileLockSync(lockDir, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(existsSync(lockDir)).toBe(false);
  });

  it('steals a dead-pid lock and fires onSteal with the pid', () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    writeFileSync(join(lockDir, 'pid'), String(dead.pid));
    const onSteal = vi.fn();
    let ran = false;

    withFileLockSync(
      lockDir,
      () => {
        ran = true;
      },
      { pollMs: 5, timeoutMs: 200, isPidAlive: () => false, onSteal },
    );

    expect(ran).toBe(true);
    expect(onSteal).toHaveBeenCalledWith(dead.pid);
  });

  it('steals a pid-less lock dir whose mtime is past graceMs (no onSteal arm)', () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    const past = new Date(Date.now() - 1_000);
    utimesSync(lockDir, past, past);
    let ran = false;

    withFileLockSync(
      lockDir,
      () => {
        ran = true;
      },
      { pollMs: 5, timeoutMs: 200, graceMs: 10 },
    );

    expect(ran).toBe(true);
  });

  it('throws a stuck timeout error when the holder is alive', () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '12345');
    const fn = vi.fn();

    expect(() =>
      withFileLockSync(lockDir, fn, {
        pollMs: 5,
        timeoutMs: 25,
        isPidAlive: () => true,
      }),
    ).toThrow(/stuck/);

    expect(fn).not.toHaveBeenCalled();
  });

  it('treats an unparseable pid file as orphaned and steals it once stale', () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), 'not-a-pid');
    const past = new Date(Date.now() - 1_000);
    utimesSync(lockDir, past, past);
    const onSteal = vi.fn();
    let ran = false;

    withFileLockSync(
      lockDir,
      () => {
        ran = true;
      },
      { pollMs: 5, timeoutMs: 200, graceMs: 10, onSteal },
    );

    expect(ran).toBe(true);
    expect(onSteal).toHaveBeenCalledWith(null);
  });

  it('does not delete a live lock when the observed dead holder was replaced mid-steal (#597)', () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '999999');
    const onSteal = vi.fn();
    const fn = vi.fn();

    let calls = 0;
    const isPidAlive = vi.fn(() => {
      calls++;
      if (calls === 1) {
        rmSync(lockDir, { recursive: true, force: true });
        mkdirSync(lockDir);
        writeFileSync(join(lockDir, 'pid'), '4242');
        return false;
      }
      return true;
    });

    expect(() => withFileLockSync(lockDir, fn, { pollMs: 5, timeoutMs: 25, isPidAlive, onSteal })).toThrow(/stuck/);

    expect(fn).not.toHaveBeenCalled();
    expect(onSteal).not.toHaveBeenCalled();
    expect(existsSync(lockDir)).toBe(true);
    expect(readFileSync(join(lockDir, 'pid'), 'utf-8')).toBe('4242');
  });

  it('backs off while another stealer holds the steal arbiter', () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '999999');
    mkdirSync(`${lockDir}.steal`);
    const onSteal = vi.fn();
    const fn = vi.fn();

    expect(() =>
      withFileLockSync(lockDir, fn, {
        pollMs: 5,
        timeoutMs: 25,
        graceMs: 10_000,
        isPidAlive: () => false,
        onSteal,
      }),
    ).toThrow(/stuck/);

    expect(fn).not.toHaveBeenCalled();
    expect(onSteal).not.toHaveBeenCalled();
    expect(existsSync(lockDir)).toBe(true);
    expect(existsSync(`${lockDir}.steal`)).toBe(true);
  });

  it('reaps a stale steal arbiter and then steals', () => {
    const lockDir = makeLockDir();
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '999999');
    mkdirSync(`${lockDir}.steal`);
    const past = new Date(Date.now() - 1_000);
    utimesSync(`${lockDir}.steal`, past, past);
    const onSteal = vi.fn();
    let ran = false;

    withFileLockSync(
      lockDir,
      () => {
        ran = true;
      },
      { pollMs: 5, timeoutMs: 200, graceMs: 10, isPidAlive: () => false, onSteal },
    );

    expect(ran).toBe(true);
    expect(onSteal).toHaveBeenCalledWith(999999);
    expect(existsSync(`${lockDir}.steal`)).toBe(false);
    expect(existsSync(lockDir)).toBe(false);
  });
});
