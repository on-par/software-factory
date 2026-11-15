import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecFn } from '../utils/exec.js';
import {
  countExternalTcpConnections,
  defaultProcessActivityProbe,
  parsePsCpuSeconds,
  type ProcessActivitySample,
  resolveStallSeconds,
  startStallWatch,
} from './stall-watch.js';

describe('startStallWatch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const watch = (probe: () => Promise<ProcessActivitySample | undefined>, stallMs = 60_000) => {
    const killed: number[] = [];
    const stalls: number[] = [];
    const kill = async (pgid: number) => killed.push(pgid);
    const onStall = (idleMs: number) => stalls.push(idleMs);
    const w = startStallWatch(7, { stallMs, intervalMs: 10_000, probe, now: () => Date.now(), kill, onStall });
    return { w, killed, stalls };
  };

  it('kills a process group idle past the stall threshold', async () => {
    const { killed, stalls } = watch(async () => ({ cpuSeconds: 5, tcpConnections: 0 }));
    await vi.advanceTimersByTimeAsync(80_000);
    expect(stalls).toHaveLength(1);
    expect(killed).toEqual([7]);
  });

  it('does not flag a group that keeps using CPU or holds an external TCP connection', async () => {
    let cpu = 0;
    const busy = watch(async () => ({ cpuSeconds: (cpu += 5), tcpConnections: 0 }));
    const net = watch(async () => ({ cpuSeconds: 5, tcpConnections: 1 }));
    await vi.advanceTimersByTimeAsync(600_000);
    expect([busy.killed, busy.stalls, net.killed, net.stalls]).toEqual([[], [], [], []]);
  });

  it('treats a failed probe as active', async () => {
    const unknown = watch(async () => undefined);
    const thrown = watch(async () => {
      throw new Error('ps gone');
    });
    await vi.advanceTimersByTimeAsync(600_000);
    expect([unknown.killed, thrown.killed]).toEqual([[], []]);
  });

  it('noteActivity resets the idle clock', async () => {
    const { w, killed } = watch(async () => ({ cpuSeconds: 5, tcpConnections: 0 }));
    await vi.advanceTimersByTimeAsync(50_000);
    w.noteActivity();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(killed).toEqual([7]);
  });

  it('stop() prevents any further kill', async () => {
    const { w, killed } = watch(async () => ({ cpuSeconds: 5, tcpConnections: 0 }));
    await vi.advanceTimersByTimeAsync(30_000);
    w.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(killed).toEqual([]);
  });

  it('stallMs 0 returns a no-op watch', async () => {
    let probes = 0;
    const probe = async () => ({ cpuSeconds: 5 + probes++, tcpConnections: 0 });
    const { w, killed } = watch(probe, 0);
    w.noteActivity();
    await vi.advanceTimersByTimeAsync(300_000);
    w.stop();
    expect(probes).toBe(0);
    expect(killed).toEqual([]);
  });
});

describe('resolveStallSeconds', () => {
  it('defaults to 900 and honours FACTORY_HARNESS_STALL_SECONDS, 0 disables', () => {
    const at = (v?: string) => resolveStallSeconds(v === undefined ? {} : { FACTORY_HARNESS_STALL_SECONDS: v });
    expect(at()).toBe(900);
    expect(at('')).toBe(900);
    expect(at('abc')).toBe(900);
    expect(at('-5')).toBe(900);
    expect(at('0.5')).toBe(900);
    expect(at('0')).toBe(0);
    expect(at('120')).toBe(120);
  });
});

describe('parsePsCpuSeconds', () => {
  it('parses macOS and Linux formats', () => {
    expect(parsePsCpuSeconds('0:01.50')).toBe(1.5);
    expect(parsePsCpuSeconds('01:02:03')).toBe(3723);
    expect(parsePsCpuSeconds('1-00:00:01')).toBe(86401);
    expect(parsePsCpuSeconds('bad')).toBeUndefined();
  });
});

describe('countExternalTcpConnections', () => {
  it('counts external connections and ignores group-internal loopback pairs', () => {
    expect(countExternalTcpConnections('p1\nn10.0.0.2:5000->93.184.216.34:443\n')).toBe(1);
    expect(countExternalTcpConnections('p1\nn127.0.0.1:1->127.0.0.1:2\np2\nn127.0.0.1:2->127.0.0.1:1\n')).toBe(0);
    expect(countExternalTcpConnections('')).toBe(0);
  });
});

describe('defaultProcessActivityProbe', () => {
  const fake =
    (ps: string | Error, lsof: string | Error): ExecFn =>
    async (cmd) => {
      const out = cmd.startsWith('ps') ? ps : lsof;
      if (out instanceof Error) throw out;
      return { stdout: out, stderr: '' };
    };
  const psOut = '  10 7 0:01.00\n  11 7 0:02.50\n  12 8 9:00.00\n';

  it('sums group rows and counts external connections', async () => {
    const sample = await defaultProcessActivityProbe(7, fake(psOut, 'p10\nn1.1.1.1:1->2.2.2.2:443\n'));
    expect(sample).toEqual({ cpuSeconds: 3.5, tcpConnections: 1 });
  });

  it('maps lsof exit 1 with empty stdout (nothing matched) to 0 connections', async () => {
    const err = Object.assign(new Error('none'), { code: 1, stdout: '' });
    expect(await defaultProcessActivityProbe(7, fake(psOut, err))).toEqual({ cpuSeconds: 3.5, tcpConnections: 0 });
  });

  it('returns undefined on ps failure, no rows, unparsable time or other lsof failure', async () => {
    expect(await defaultProcessActivityProbe(7, fake(new Error('x'), ''))).toBeUndefined();
    expect(await defaultProcessActivityProbe(99, fake(psOut, ''))).toBeUndefined();
    expect(await defaultProcessActivityProbe(7, fake('10 7 junk\n', ''))).toBeUndefined();
    const err = Object.assign(new Error('boom'), { code: 2, stdout: '' });
    expect(await defaultProcessActivityProbe(7, fake(psOut, err))).toBeUndefined();
  });
});
