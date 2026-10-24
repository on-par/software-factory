import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { defaultFactoryConfig } from '@on-par/factory-config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FactoryConfigSchema, type DiskGuardPolicy } from '../config/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import {
  BYTES_PER_GB,
  claimDiskAlert,
  createDiskGuard,
  evaluateDiskGuard,
  formatDiskHold,
  hostDiskAlertFile,
  readDiskFree,
} from './disk-guard.js';

const GB = BYTES_PER_GB;
const fake = (freeGb: number) => () => ({ bavail: freeGb * 1024, bsize: GB / 1024 });
const policy = (over: Partial<DiskGuardPolicy> = {}): DiskGuardPolicy => ({
  enabled: true,
  minFreeGb: 10,
  retryMs: 300_000,
  ...over,
});

describe('readDiskFree', () => {
  const tmp = createTempDirs();
  afterEach(() => tmp.cleanup());

  it('returns the minimum across paths with the path that had it', async () => {
    const dir = await tmp.make('disk-');
    const sizes: Record<string, number> = { [dir]: 50, [join(dir, 'b')]: 5 };
    mkdirSync(join(dir, 'b'));
    const s = readDiskFree([dir, join(dir, 'b')], (p) => ({ bavail: sizes[p] ?? 0, bsize: GB }));
    expect(s).toEqual({ freeGb: 5, path: join(dir, 'b') });
  });

  it('converts bigint fields', async () => {
    const dir = await tmp.make('disk-');
    expect(readDiskFree([dir], () => ({ bavail: 20n, bsize: BigInt(GB) }))?.freeGb).toBe(20);
  });

  it('walks up to the nearest existing ancestor for a missing path', async () => {
    const dir = await tmp.make('disk-');
    const seen: string[] = [];
    readDiskFree([join(dir, 'x', 'y')], (p) => {
      seen.push(p);
      return { bavail: 1, bsize: GB };
    });
    expect(seen).toEqual([dir]);
  });

  it('returns null when statfs throws or is non-finite', async () => {
    const dir = await tmp.make('disk-');
    expect(
      readDiskFree([dir], () => {
        throw new Error('EACCES');
      }),
    ).toBeNull();
    expect(readDiskFree([dir], () => ({ bavail: Number.NaN, bsize: GB }))).toBeNull();
  });
});

describe('evaluateDiskGuard', () => {
  it('holds strictly below the threshold', () => {
    expect(evaluateDiskGuard(policy(), { freeGb: 9.9, path: '/w' })).toEqual({
      kind: 'hold',
      freeGb: 9.9,
      thresholdGb: 10,
      path: '/w',
      retryMs: 300_000,
    });
  });

  it('claims at the threshold, when disabled, and with no sample', () => {
    expect(evaluateDiskGuard(policy(), { freeGb: 10, path: '/w' }).kind).toBe('claim');
    expect(evaluateDiskGuard(policy({ enabled: false }), { freeGb: 0, path: '/w' }).kind).toBe('claim');
    expect(evaluateDiskGuard(policy(), null).kind).toBe('claim');
    expect(evaluateDiskGuard(policy(), { freeGb: Number.NaN, path: '/w' }).kind).toBe('claim');
  });
});

describe('createDiskGuard', () => {
  const tmp = createTempDirs();
  afterEach(() => tmp.cleanup());
  const config = FactoryConfigSchema.parse(defaultFactoryConfig);

  it('FACTORY_MIN_FREE_GB=0 disables the guard even at 0 bytes free', async () => {
    const root = await tmp.make('disk-');
    const statfs = vi.fn(fake(0));
    const guard = createDiskGuard(config, {
      repoRoot: root,
      ghRepo: 'o/r',
      stateRoot: root,
      env: { FACTORY_MIN_FREE_GB: '0' },
      statfs,
    });
    expect(guard.check()).toEqual({ kind: 'claim' });
    expect(statfs).not.toHaveBeenCalled();
    expect(guard.status()?.low).toBe(false);
  });

  it('holds and reports status when low, checking worktree root and state root', async () => {
    const root = await tmp.make('disk-');
    const guard = createDiskGuard(config, { repoRoot: root, ghRepo: 'o/r', stateRoot: root, env: {}, statfs: fake(3.14) });
    expect(guard.paths).toHaveLength(2);
    expect(guard.check().kind).toBe('hold');
    expect(guard.status()).toEqual({ freeGb: 3.1, thresholdGb: 10, low: true });
  });

  it('claims and reports not low with enough space; status is null when unreadable', async () => {
    const root = await tmp.make('disk-');
    const ctx = { repoRoot: root, ghRepo: 'o/r', stateRoot: root, env: {} };
    expect(createDiskGuard(config, { ...ctx, statfs: fake(100) }).check()).toEqual({ kind: 'claim' });
    const broken = createDiskGuard(config, {
      ...ctx,
      statfs: () => {
        throw new Error('ENOSYS');
      },
    });
    expect(broken.status()).toBeNull();
    expect(broken.check()).toEqual({ kind: 'claim' });
  });
});

describe('formatDiskHold', () => {
  it('names free, threshold and path', () => {
    const line = formatDiskHold(
      "lane 'a' not claiming:",
      { kind: 'hold', freeGb: 2.34, thresholdGb: 10, path: '/w', retryMs: 1 },
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(line).toContain('free=2.3 GB');
    expect(line).toContain('threshold=10 GB');
    expect(line).toContain('path=/w');
    expect(line).toContain('2026-01-01T00:00:00.000Z');
  });
});

describe('claimDiskAlert', () => {
  const tmp = createTempDirs();
  afterEach(() => tmp.cleanup());

  it('puts the alert file under ~/.factory/host', () => {
    expect(hostDiskAlertFile('/h')).toBe('/h/.factory/host/disk-alert.json');
  });

  it('allows one alert per hour', async () => {
    const file = hostDiskAlertFile(await tmp.make('disk-'));
    const t0 = new Date('2026-01-01T00:00:00Z');
    expect(claimDiskAlert(file, t0)).toBe(true);
    expect(claimDiskAlert(file, new Date(t0.getTime() + 59 * 60_000))).toBe(false);
    expect(claimDiskAlert(file, new Date(t0.getTime() + 61 * 60_000))).toBe(true);
  });

  it('treats a garbage file as no prior alert', async () => {
    const dir = await tmp.make('disk-');
    const file = join(dir, 'alert.json');
    writeFileSync(file, 'not json');
    expect(claimDiskAlert(file, new Date())).toBe(true);
  });
});
