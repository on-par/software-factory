import { describe, expect, it, vi } from 'vitest';

import type { DiskSample } from '@on-par/factory-core/internal';

import { createDiskGuard, diskGatedSlotPort } from './disk-guard.js';
import type { Notifier, NotifySummary } from './notify.js';

const GIB = 1024 ** 3;
const gb =
  (n: number) =>
  (path: string): DiskSample => ({ path, freeBytes: n * GIB });

function setup(seq: number[], extra: Partial<Parameters<typeof createDiskGuard>[0]> = {}) {
  const events: string[] = [];
  const notified: NotifySummary[] = [];
  const notifier: Notifier = { notify: (s) => void notified.push(s), settle: async () => {}, parked: 0 };
  const stamps = new Set<string>();
  let i = 0;
  const guard = createDiskGuard({
    minFreeGb: 10,
    paths: ['/w'],
    retryMs: 5,
    eventsFile: 'e',
    stopFile: 'STOP',
    emitEvent: ((_f: string, type: string, _i: unknown, msg: string) => void events.push(`${type}:${msg}`)) as never,
    notifier,
    alertFile: `/tmp/disk-guard-test-${Math.random()}.json`,
    probe: (p) => gb(seq[Math.min(i++, seq.length - 1)])(p),
    sleep: async () => {},
    pathExists: () => false,
    host: 'h',
    ...extra,
  });
  void stamps;
  return { guard, events, notified };
}

describe('createDiskGuard', () => {
  it('emits one disk_low, one alert, a warn per retry and one disk_recovered', async () => {
    const { guard, events, notified } = setup([1, 1, 50]);
    expect(await guard.waitForSpace("lane 'a'")).toBe('ok');
    expect(events.filter((e) => e.startsWith('disk_low:'))).toHaveLength(1);
    expect(events.filter((e) => e.startsWith('warn:'))).toHaveLength(2);
    expect(events.filter((e) => e.startsWith('disk_recovered:'))).toHaveLength(1);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ kind: 'disk_low', host: 'h', thresholdGb: 10, path: '/w' });
  });

  it('does nothing when there is enough space', async () => {
    const sleep = vi.fn(async () => {});
    const { guard, events, notified } = setup([50], { sleep });
    expect(await guard.waitForSpace('x')).toBe('ok');
    expect(events).toEqual([]);
    expect(notified).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('works without a notifier and is off at minFreeGb 0', async () => {
    const a = setup([1, 50], { notifier: undefined });
    await a.guard.waitForSpace('x');
    expect(a.events.some((e) => e.startsWith('disk_low:'))).toBe(true);
    const probe = vi.fn(gb(0));
    const b = setup([0], { minFreeGb: 0, probe });
    expect(b.guard.check()).toEqual({ kind: 'ok', freeGb: null });
    expect(probe).not.toHaveBeenCalled();
  });

  it('alerts once per hour across low episodes but logs each episode', () => {
    const file = `/tmp/disk-guard-test-${Math.random()}.json`;
    const { guard, events, notified } = setup([1, 50, 1], { alertFile: file });
    guard.check();
    guard.check();
    guard.check();
    expect(events.filter((e) => e.startsWith('disk_low:'))).toHaveLength(2);
    expect(notified).toHaveLength(1);
  });

  it('fails open when every probe throws', () => {
    const { guard, events } = setup([1], {
      probe: () => {
        throw new Error('EACCES');
      },
    });
    expect(guard.check()).toEqual({ kind: 'ok', freeGb: null });
    expect(events).toEqual([]);
  });

  it('fails open when the event sink throws', () => {
    const { guard } = setup([1], {
      emitEvent: (() => {
        throw new Error('boom');
      }) as never,
    });
    expect(guard.check().kind).toBe('ok');
  });

  it('returns stopped on STOP unless observeStop is false', async () => {
    const a = setup([1, 1, 50], { pathExists: () => true });
    expect(await a.guard.waitForSpace('x')).toBe('stopped');
    const b = setup([1, 1, 50], { pathExists: () => true });
    expect(await b.guard.waitForSpace('x', { observeStop: false })).toBe('ok');
  });
});

describe('diskGatedSlotPort', () => {
  it('returns the slot port unchanged without a guard', () => {
    const slot = vi.fn();
    expect(diskGatedSlotPort(slot as never, undefined, 1)).toBe(slot);
  });

  it('phase gate lets the running build finish and holds check until space recovers', async () => {
    const order: string[] = [];
    let free = 50;
    let polls = 0;
    const { guard } = setup([], {
      probe: (p) => {
        if (free === 1 && ++polls >= 3) free = 50;
        return gb(free)(p);
      },
    });
    const slot = (async (phase: string, fn: () => Promise<unknown>) => {
      order.push(`slot:${phase}`);
      return fn();
    }) as never;
    const gated = diskGatedSlotPort(slot, guard, 7);
    await gated('build', async () => {
      free = 1; // disk drops while BUILD is running
      order.push('build-done');
      return undefined as never;
    });
    expect(order).toEqual(['slot:build', 'build-done']);
    await gated('check', async () => {
      order.push(`check-ran@${free}`);
      return undefined as never;
    });
    expect(order).toEqual(['slot:build', 'build-done', 'slot:check', 'check-ran@50']);
    expect(polls).toBeGreaterThanOrEqual(3);
  });
});
