// packages/cli/src/cli/notify.test.ts — opt-in --notify command tests (#3512)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ParkPayload } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createNotifier, type Notifier, type NotifySummary, resolveNotifyCommand, withDiskLowNotify, withParkNotify } from './notify.js';

const park: ParkPayload = { reason: 'fail', decision: 'park', lane: 'app', blockedBehind: [] };
const parkSummary: NotifySummary = { kind: 'park', ts: 't1', issue: 7, lane: 'app', message: 'parked', park };
const drainSummary: NotifySummary = { kind: 'drain', ts: 't2', message: 'queue drained', parked: 1 };

const tmp = createTempDirs();
let dir: string;
beforeEach(() => {
  dir = tmp.makeSync('factory-notify-');
});
afterEach(async () => {
  await tmp.cleanup();
});

describe('resolveNotifyCommand', () => {
  it('prefers the flag over the env', () => {
    expect(resolveNotifyCommand(' a ', { FACTORY_NOTIFY_CMD: 'b' })).toBe('a');
  });
  it('uses the env when there is no flag', () => {
    expect(resolveNotifyCommand(undefined, { FACTORY_NOTIFY_CMD: ' b ' })).toBe('b');
  });
  it('falls back to the env on a blank flag', () => {
    expect(resolveNotifyCommand('  ', { FACTORY_NOTIFY_CMD: 'b' })).toBe('b');
  });
  it('returns undefined when both are blank or unset', () => {
    expect(resolveNotifyCommand('', { FACTORY_NOTIFY_CMD: '  ' })).toBeUndefined();
    expect(resolveNotifyCommand(undefined, {})).toBeUndefined();
  });
});

describe('createNotifier', () => {
  it('returns undefined and never spawns when no command is configured', () => {
    const spawn = vi.fn();
    for (const cmd of [undefined, '', '   ']) expect(createNotifier(cmd, { spawn: spawn as never })).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("writes one JSON line per notify to the command's stdin and counts parks", async () => {
    const file = join(dir, 'n.ndjson');
    const n = createNotifier(`cat >> ${file}`) as Notifier;
    n.notify(parkSummary);
    n.notify(drainSummary);
    await n.settle();
    const lines = readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines).toContainEqual(parkSummary);
    expect(lines).toContainEqual(drainSummary);
    expect(n.parked).toBe(1);
  });

  it('reports a failing command and still settles', async () => {
    const onError = vi.fn();
    const n = createNotifier('exit 3', { onError }) as Notifier;
    n.notify(drainSummary);
    await n.settle();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toContain('exit 3');
  });

  it('reports a nonexistent binary', async () => {
    const onError = vi.fn();
    const n = createNotifier('/nonexistent/notify-xyz', { onError }) as Notifier;
    n.notify(drainSummary);
    await n.settle();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('does not throw when spawn throws synchronously', async () => {
    const onError = vi.fn();
    const spawn = vi.fn(() => {
      throw new Error('boom');
    });
    const n = createNotifier('x', { onError, spawn: spawn as never }) as Notifier;
    expect(() => n.notify(drainSummary)).not.toThrow();
    await n.settle();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('kills a command past the timeout', async () => {
    const onError = vi.fn();
    const n = createNotifier('sleep 5', { onError, timeoutMs: 50 }) as Notifier;
    n.notify(drainSummary);
    await n.settle();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toContain('timed out');
  });
});

describe('withParkNotify', () => {
  it('fires once per parked event with the park payload and never for build, check, plan or reason events', () => {
    const emit = vi.fn();
    const notify = vi.fn();
    const wrapped = withParkNotify(emit, { notify, settle: async () => {}, parked: 0 });
    const calls: Parameters<typeof emit>[] = [
      ['e', 'parked', 7, 'parked', { lane: 'app', park }],
      ['e', 'phase', 7, 'build', { lane: 'app', phase: 'build' }],
      ['e', 'phase', 7, 'check', { lane: 'app', phase: 'check' }],
      ['e', 'phase', 7, 'plan', { lane: 'app', phase: 'plan' }],
      ['e', 'fail', 7, 'failed', { lane: 'app', park }],
      ['e', 'escalate', 7, 'escalated', { lane: 'app', park }],
      ['e', 'lane-start', 'app', 'start', { lane: 'app' }],
      ['e', 'parked', 8, 'parked', { lane: 'app' }],
    ];
    for (const c of calls) wrapped(...(c as Parameters<typeof wrapped>));
    expect(emit.mock.calls).toEqual(calls);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'park', issue: 7, lane: 'app', park }));
  });

  it('never throws when the notifier throws, and still emits', () => {
    const emit = vi.fn();
    const notifier: Notifier = {
      notify: () => {
        throw new Error('x');
      },
      settle: async () => {},
      parked: 0,
    };
    const wrapped = withParkNotify(emit, notifier);
    expect(() => wrapped('e', 'parked', 1, 'm', { lane: 'app', park })).not.toThrow();
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

describe('withDiskLowNotify (#2284)', () => {
  const tmp = createTempDirs();
  afterEach(() => tmp.cleanup());

  it('withDiskLowNotify sends one disk_low alert per host per hour', async () => {
    const alertFile = join(await tmp.make('notify-'), 'disk-alert.json');
    const emit = vi.fn();
    const notify = vi.fn();
    const notifier: Notifier = { notify, settle: async () => {}, parked: 0 };
    let t = new Date('2026-10-16T12:00:00.000Z');
    const wrapped = withDiskLowNotify(emit as any, notifier, { alertFile, now: () => t, host: 'mini' });
    wrapped('/e', 'disk_low', 'all', 'disk low', { lane: 'app' } as any);
    t = new Date('2026-10-16T12:30:00.000Z');
    wrapped('/e', 'disk_low', 'all', 'disk low', { lane: 'app' } as any);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      kind: 'disk_low',
      ts: '2026-10-16T12:00:00.000Z',
      host: 'mini',
      lane: 'app',
      message: 'disk low',
    });
    t = new Date('2026-10-16T13:01:00.000Z');
    wrapped('/e', 'disk_low', 'all', 'disk low', { lane: 'app' } as any);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('ignores other events and survives a throwing notifier', async () => {
    const alertFile = join(await tmp.make('notify-'), 'disk-alert.json');
    const notify = vi.fn(() => {
      throw new Error('nope');
    });
    const notifier: Notifier = { notify, settle: async () => {}, parked: 0 };
    const emit = vi.fn(() => 'r');
    const wrapped = withDiskLowNotify(emit as any, notifier, { alertFile });
    wrapped('/e', 'warn', 'all', 'x');
    expect(notify).not.toHaveBeenCalled();
    expect(() => wrapped('/e', 'disk_low', 'all', 'x')).not.toThrow();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
