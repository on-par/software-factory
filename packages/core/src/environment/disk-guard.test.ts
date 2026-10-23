import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { defaultFactoryConfig } from '@on-par/factory-config';

import { FactoryConfigSchema } from '../config/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import {
  claimDiskAlertSlot,
  evaluateDiskGuard,
  formatDiskLow,
  hostDiskAlertFile,
  readFreeSpace,
  resolveDiskMinFreeGb,
} from './disk-guard.js';

const GIB = 1024 ** 3;
const tempDirs = createTempDirs();
afterEach(async () => {
  await tempDirs.cleanup();
});
const tmp = (): string => tempDirs.makeSync('disk-guard-');

describe('readFreeSpace', () => {
  it('multiplies bavail by bsize for number and bigint fields', () => {
    expect(
      readFreeSpace(
        '/x',
        () => ({ bavail: 10, bsize: 4096 }),
        () => true,
      ),
    ).toEqual({
      path: '/x',
      freeBytes: 40960,
    });
    expect(
      readFreeSpace(
        '/x',
        () => ({ bavail: 10n, bsize: 4096n }),
        () => true,
      ).freeBytes,
    ).toBe(40960);
  });

  it('walks up to the nearest existing ancestor for a missing path', () => {
    const seen: string[] = [];
    const s = readFreeSpace(
      '/a/b/c',
      (p) => {
        seen.push(p);
        return { bavail: 1, bsize: 1 };
      },
      (p) => p === '/a',
    );
    expect(seen).toEqual(['/a']);
    expect(s.path).toBe('/a/b/c');
  });

  it('stops at the filesystem root', () => {
    const seen: string[] = [];
    readFreeSpace(
      '/nope',
      (p) => (seen.push(p), { bavail: 1, bsize: 1 }),
      () => false,
    );
    expect(seen).toEqual(['/']);
  });

  it('probes a real path', () => {
    expect(readFreeSpace(join(tmp(), 'missing', 'deep')).freeBytes).toBeGreaterThan(0);
  });
});

describe('evaluateDiskGuard', () => {
  const s = (path: string, gb: number) => ({ path, freeBytes: gb * GIB });
  it('is low below the threshold, ok at and above it', () => {
    expect(evaluateDiskGuard(10, [s('/a', 9.9)])).toEqual({ kind: 'low', freeGb: 9.9, thresholdGb: 10, path: '/a' });
    expect(evaluateDiskGuard(10, [s('/a', 10)]).kind).toBe('ok');
    expect(evaluateDiskGuard(10, [s('/a', 11)])).toEqual({ kind: 'ok', freeGb: 11 });
  });
  it('uses the emptiest sample', () => {
    expect(evaluateDiskGuard(10, [s('/a', 50), s('/b', 2)])).toMatchObject({ kind: 'low', path: '/b' });
  });
  it('is ok with no samples', () => {
    expect(evaluateDiskGuard(10, [])).toEqual({ kind: 'ok', freeGb: null });
  });
  it('FACTORY_MIN_FREE_GB=0 disables the guard even at 0 bytes free', () => {
    const min = resolveDiskMinFreeGb(FactoryConfigSchema.parse(defaultFactoryConfig), { FACTORY_MIN_FREE_GB: '0' });
    expect(min).toBe(0);
    expect(evaluateDiskGuard(min, [s('/a', 0)])).toEqual({ kind: 'ok', freeGb: 0 });
    expect(evaluateDiskGuard(Number.NaN, [s('/a', 0)]).kind).toBe('ok');
  });
  it('formats the low message', () => {
    expect(formatDiskLow({ kind: 'low', freeGb: 0.1, thresholdGb: 10, path: '/w' })).toBe(
      'free=0.1 GB threshold=10 GB path=/w',
    );
  });
});

describe('claimDiskAlertSlot', () => {
  it('allows one alert per interval', () => {
    const file = join(tmp(), 'nested', 'disk-alert.json');
    const t0 = new Date('2026-01-01T00:00:00Z');
    expect(claimDiskAlertSlot(file, t0)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).lastAlertAt).toBe(t0.toISOString());
    expect(claimDiskAlertSlot(file, new Date(t0.getTime() + 59 * 60_000))).toBe(false);
    expect(claimDiskAlertSlot(file, new Date(t0.getTime() + 60 * 60_000))).toBe(true);
  });
  it('treats a garbled stamp as never alerted', () => {
    const file = join(tmp(), 'a.json');
    writeFileSync(file, '{nope');
    expect(claimDiskAlertSlot(file, new Date())).toBe(true);
  });
  it('still alerts when the stamp cannot be written', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'file'), 'x');
    expect(claimDiskAlertSlot(join(dir, 'file', 'sub', 'a.json'), new Date())).toBe(true);
  });
});

describe('hostDiskAlertFile', () => {
  it('lives under ~/.factory/host and honours the env override only without a home', () => {
    expect(hostDiskAlertFile('/h')).toBe('/h/.factory/host/disk-alert.json');
    const prev = process.env.FACTORY_HOST_DISK_ALERT_FILE;
    process.env.FACTORY_HOST_DISK_ALERT_FILE = '/o/a.json';
    try {
      expect(hostDiskAlertFile()).toBe('/o/a.json');
      expect(hostDiskAlertFile('/h')).toBe('/h/.factory/host/disk-alert.json');
    } finally {
      if (prev === undefined) delete process.env.FACTORY_HOST_DISK_ALERT_FILE;
      else process.env.FACTORY_HOST_DISK_ALERT_FILE = prev;
    }
  });
});

describe('resolveDiskMinFreeGb', () => {
  const cfg = FactoryConfigSchema.parse(defaultFactoryConfig);
  it('defaults to 10 and honours config', () => {
    expect(defaultFactoryConfig.disk.minFreeGb).toBe(10);
    expect(resolveDiskMinFreeGb(cfg, {})).toBe(10);
    expect(resolveDiskMinFreeGb({ ...cfg, disk: { minFreeGb: 3 } }, {})).toBe(3);
  });
  it('parses valid env and ignores malformed values', () => {
    expect(resolveDiskMinFreeGb(cfg, { FACTORY_MIN_FREE_GB: '2.5' })).toBe(2.5);
    for (const bad of ['abc', '-5', 'NaN', '', '  ']) {
      expect(resolveDiskMinFreeGb(cfg, { FACTORY_MIN_FREE_GB: bad })).toBe(10);
    }
  });
});
