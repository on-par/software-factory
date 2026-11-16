// packages/cli/src/cli/notify.test.ts — opt-in --notify command tests (#3512)

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ParkPayload } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createNotifier,
  type Notifier,
  type NotifySummary,
  resolveNotifyCommand,
  withDiskLowNotify,
  withParkNotify,
} from './notify.js';

const park: ParkPayload = { reason: 'fail', decision: 'park', lane: 'app', blockedBehind: [] };
const parkSummary: NotifySummary = { kind: 'park', ts: 't1', issue: 7, lane: 'app', message: 'parked', park };
const drainSummary: NotifySummary = { kind: 'drain', ts: 't2', message: 'queue drained', parked: 1 };

const errs = (list: string[] = []) => ({ list, onError: (m: string) => void list.push(m) });

const failures = async (cmd: string, deps: Parameters<typeof createNotifier>[1] = {}) => {
  const { list, onError } = errs();
  const n = createNotifier(cmd, { onError, ...deps }) as Notifier;
  n.notify(drainSummary);
  await n.settle();
  return list;
};

const recorder = (emitted: unknown[][] = []) => ({
  emitted,
  emit: ((...a: unknown[]) => void emitted.push(a)) as never,
});

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
  it('reports a child process error and settles', async () => {
    const { list, onError } = errs();
    const spawnMissing = new Proxy(spawn, { apply: () => spawn('/nonexistent/factory-notify-test') });
    const notifier = createNotifier('notify', { spawn: spawnMissing, onError });
    expect(notifier).toBeDefined();
    notifier?.notify(drainSummary);
    await notifier?.settle();
    expect(list).toHaveLength(1);
    expect(list[0]).toContain('ENOENT');
  });

  it('reports an stdin error once even when the child later fails', async () => {
    const { list, onError } = errs();
    const spawnChild = new Proxy(spawn, {
      apply: () => {
        const child = spawn(process.execPath, ['-e', 'process.exit(2)']);
        queueMicrotask(() => child.stdin.emit('error', new Error('broken pipe')));
        return child;
      },
    });
    const notifier = createNotifier('notify', { spawn: spawnChild, onError });
    notifier?.notify(drainSummary);
    await notifier?.settle();
    expect(list).toEqual(["notify command 'notify' failed: stdin: broken pipe"]);
  });

  it('returns undefined and never spawns when no command is configured', () => {
    let spawned = 0;
    const spawn = () => (spawned++, undefined as never);
    for (const cmd of [undefined, '', '   ']) expect(createNotifier(cmd, { spawn })).toBeUndefined();
    expect(spawned).toBe(0);
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
    const list = await failures('exit 3');
    expect(list).toHaveLength(1);
    expect(list[0]).toContain('exit 3');
  });

  it('reports a nonexistent binary', async () => {
    const list = await failures('/nonexistent/notify-xyz');
    expect(list).toHaveLength(1);
  });

  it('does not throw when spawn throws synchronously', async () => {
    const spawn = () => {
      throw new Error('boom');
    };
    const list = await failures('x', { spawn });
    expect(list[0]).toContain('boom');
  });

  it('kills a command past the timeout', async () => {
    const list = await failures('sleep 5', { timeoutMs: 50 });
    expect(list).toHaveLength(1);
    expect(list[0]).toContain('timed out');
  });
});

describe('withParkNotify', () => {
  it('fires once per parked event with the park payload and never for build, check, plan or reason events', () => {
    const { emitted, emit } = recorder();
    const sent: NotifySummary[] = [];
    const wrapped = withParkNotify(emit, { notify: (s) => void sent.push(s), settle: async () => {}, parked: 0 });
    const calls: unknown[][] = [
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
    expect(emitted).toEqual(calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'park', issue: 7, lane: 'app', park });
  });

  it('never throws when the notifier throws, and still emits', () => {
    const { emitted, emit } = recorder();
    const notifier: Notifier = {
      notify: () => {
        throw new Error('x');
      },
      settle: async () => {},
      parked: 0,
    };
    const wrapped = withParkNotify(emit, notifier);
    expect(() => wrapped('e', 'parked', 1, 'm', { lane: 'app', park })).not.toThrow();
    expect(emitted).toHaveLength(1);
  });
});

describe('withDiskLowNotify (#2284)', () => {
  const tmp = createTempDirs();
  afterEach(() => tmp.cleanup());

  it('withDiskLowNotify sends one disk_low alert per host per hour', async () => {
    const alertFile = join(await tmp.make('notify-'), 'disk-alert.json');
    const { emitted, emit } = recorder();
    const sent: NotifySummary[] = [];
    const notifier: Notifier = { notify: (s) => void sent.push(s), settle: async () => {}, parked: 0 };
    let t = new Date('2026-10-16T12:00:00.000Z');
    const wrapped = withDiskLowNotify(emit as any, notifier, { alertFile, now: () => t, host: 'mini' });
    wrapped('/e', 'disk_low', 'all', 'disk low', { lane: 'app' } as any);
    t = new Date('2026-10-16T12:30:00.000Z');
    wrapped('/e', 'disk_low', 'all', 'disk low', { lane: 'app' } as any);
    expect(emitted).toHaveLength(2);
    expect(sent).toEqual([
      { kind: 'disk_low', ts: '2026-10-16T12:00:00.000Z', host: 'mini', lane: 'app', message: 'disk low' },
    ]);
    t = new Date('2026-10-16T13:01:00.000Z');
    wrapped('/e', 'disk_low', 'all', 'disk low', { lane: 'app' } as any);
    expect(sent).toHaveLength(2);
  });

  it('ignores other events and survives a throwing notifier', async () => {
    const alertFile = join(await tmp.make('notify-'), 'disk-alert.json');
    let attempts = 0;
    const notify = () => {
      attempts++;
      throw new Error('nope');
    };
    const notifier: Notifier = { notify, settle: async () => {}, parked: 0 };
    const emit = () => 'r';
    const wrapped = withDiskLowNotify(emit as any, notifier, { alertFile });
    wrapped('/e', 'warn', 'all', 'x');
    expect(attempts).toBe(0);
    expect(() => wrapped('/e', 'disk_low', 'all', 'x')).not.toThrow();
    expect(attempts).toBe(1);
  });
});
