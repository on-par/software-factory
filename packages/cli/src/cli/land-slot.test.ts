// packages/cli/src/cli/land-slot.test.ts — the host landing slot with real file locks (#3957)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { landLockFor, withLandingSlot } from './land-slot.js';

const dirs = createTempDirs();

function setup() {
  const dir = dirs.makeSync('land-slot-');
  return {
    repoRoot: dir,
    paths: { mergeLock: join(dir, 'merge.lock'), landSlotLock: join(dir, 'land-slot.lock') },
  };
}

function gate() {
  let open!: () => void;
  let fail!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    open = res;
    fail = rej;
  });
  return { promise, open, fail };
}

describe('landing slot (#3957)', () => {
  beforeEach(() => {
    // withFileLock polls on a 5s setTimeout; fake only timers so the lock itself stays real.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    return dirs.cleanup();
  });

  it('a land waits for the landing slot while a deferred retry holds it', async () => {
    const { repoRoot, paths } = setup();
    const hold = gate();
    const holder = withLandingSlot(paths, () => hold.promise);
    let ran = false;
    const land = landLockFor(
      repoRoot,
      paths,
      () => {},
      false,
    )(async () => {
      ran = true;
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ran).toBe(false);
    hold.open();
    await holder;
    await vi.advanceTimersByTimeAsync(6_000);
    await land;
    expect(ran).toBe(true);
  });

  it('a land proceeds once the retry releases the slot after a failure', async () => {
    const { repoRoot, paths } = setup();
    const hold = gate();
    const holder = withLandingSlot(paths, () => hold.promise).catch((e: Error) => e.message);
    let ran = false;
    const land = landLockFor(
      repoRoot,
      paths,
      () => {},
      false,
    )(async () => {
      ran = true;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ran).toBe(false);
    hold.fail(new Error('retry failed'));
    expect(await holder).toBe('retry failed');
    await vi.advanceTimersByTimeAsync(6_000);
    await land;
    expect(ran).toBe(true);
  });

  it('a lock for a caller that already holds the slot does not deadlock', async () => {
    const { repoRoot, paths } = setup();
    let ran = false;
    await withLandingSlot(paths, () =>
      landLockFor(
        repoRoot,
        paths,
        () => {},
        true,
      )(async () => {
        ran = true;
      }),
    );
    expect(ran).toBe(true);
  });

  it('steals a slot and a merge lock left by a dead holder and logs each steal', async () => {
    const { repoRoot, paths } = setup();
    for (const lock of [paths.landSlotLock, paths.mergeLock]) {
      mkdirSync(lock);
      writeFileSync(join(lock, 'pid'), '2147483646');
    }
    const logs: string[] = [];
    let ran = false;
    await landLockFor(
      repoRoot,
      paths,
      (_t, msg) => logs.push(msg),
      false,
    )(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(logs).toHaveLength(2);
    expect(logs.every((m) => m.includes('dead holder pid 2147483646'))).toBe(true);
  });
});
