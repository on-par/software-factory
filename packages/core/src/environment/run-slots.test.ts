import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRunSlotGate, withRunAndHostBuildSlot, type RunSlotGate } from './run-slots.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'factory-run-slots-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function slotFiles(): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.startsWith('slot-'));
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await tick(10);
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

function harness(runSlots: RunSlotGate | undefined, maxBuilds: number) {
  const logs: string[] = [];
  const state = { active: 0, maxActive: 0 };
  const gates: Array<() => void> = [];
  const lane = (issue: number) =>
    withRunAndHostBuildSlot(
      { dir, maxBuilds, repo: 'o/r', issue, phase: 'build', pollMs: 5, log: (m) => logs.push(m), runSlots },
      async () => {
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        await new Promise<void>((resolve) => gates.push(resolve));
        state.active -= 1;
        return issue;
      },
    );
  return { logs, state, gates, lane };
}

describe('createRunSlotGate (#3049)', () => {
  it('rejects non-integer or < 1 limits and accepts 1', () => {
    for (const bad of [0, -1, 1.5]) expect(() => createRunSlotGate(bad)).toThrow(RangeError);
    expect(createRunSlotGate(1).max).toBe(1);
  });

  it('queues FIFO, reports the wait once, and ignores a double release', async () => {
    const gate = createRunSlotGate(1);
    const waits: Array<[number, number]> = [];
    const r1 = await gate.acquire();
    const order: number[] = [];
    const p2 = gate.acquire((a, m) => waits.push([a, m])).then((r) => (order.push(2), r));
    const p3 = gate.acquire().then((r) => (order.push(3), r));
    await tick(5);
    expect(waits).toEqual([[1, 1]]);
    r1();
    r1();
    const r2 = await p2;
    await tick(5);
    expect(order).toEqual([2]);
    expect(gate.active).toBe(1);
    r2();
    (await p3)();
    expect(order).toEqual([2, 3]);
    expect(gate.active).toBe(0);
  });
});

describe('withRunAndHostBuildSlot (#3049)', () => {
  it('run cap stricter (run 1, host 2): two lanes never build at once and the second logs waiting for run build slot (1/1 in use)', async () => {
    const h = harness(createRunSlotGate(1), 2);
    const p1 = h.lane(1);
    const p2 = h.lane(2);
    await until(() => h.gates.length > 0 && h.logs.includes('waiting for run build slot (1/1 in use)'));
    expect(h.state.maxActive).toBe(1);
    expect(await slotFiles()).toHaveLength(1);
    expect(h.logs).toContain('waiting for run build slot (1/1 in use)');
    expect(h.logs.some((l) => l.includes('waiting for host build slot'))).toBe(false);
    h.gates[0]!();
    await p1;
    await until(() => h.gates.length > 1);
    h.gates[1]!();
    await expect(p2).resolves.toBe(2);
    expect(h.state.maxActive).toBe(1);
  });

  it('host cap stricter (run 3, host 1): the second lane waits on the host slot and logs waiting for host build slot (1/1 in use), never the run line', async () => {
    const h = harness(createRunSlotGate(3), 1);
    const p1 = h.lane(1);
    const p2 = h.lane(2);
    await until(() => h.gates.length > 0 && h.logs.includes('waiting for host build slot (1/1 in use)'));
    expect(h.state.maxActive).toBe(1);
    expect(h.logs).toContain('waiting for host build slot (1/1 in use)');
    expect(h.logs.some((l) => l.includes('run build slot'))).toBe(false);
    h.gates[0]!();
    await p1;
    await until(() => h.gates.length > 1);
    h.gates[1]!();
    await expect(p2).resolves.toBe(2);
    expect(h.state.maxActive).toBe(1);
  });

  it('frees both slots when fn throws', async () => {
    const gate = createRunSlotGate(1);
    await expect(
      withRunAndHostBuildSlot(
        { dir, maxBuilds: 1, repo: 'o/r', issue: 1, phase: 'check', pollMs: 5, runSlots: gate },
        async () => Promise.reject(new Error('boom')),
      ),
    ).rejects.toThrow('boom');
    expect(gate.active).toBe(0);
    expect(await slotFiles()).toEqual([]);
  });

  it('behaves as withHostBuildSlot when no run gate is supplied', async () => {
    const r = await withRunAndHostBuildSlot(
      { dir, maxBuilds: 1, repo: 'o/r', issue: 1, phase: 'build', pollMs: 5 },
      async () => 'ok',
    );
    expect(r).toBe('ok');
    expect(await slotFiles()).toEqual([]);
  });
});
