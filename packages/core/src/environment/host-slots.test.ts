import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultFactoryConfig } from '@on-par/factory-config';

import { loadFactoryConfig } from '../config/index.js';
import {
  acquireHostBuildSlot,
  gateHostPhases,
  hostBuildSlotsDir,
  readHostBuildSlots,
  withHostBuildSlot,
  type AcquireHostBuildSlotOptions,
} from './host-slots.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'factory-host-slots-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function opts(over: Partial<AcquireHostBuildSlotOptions> = {}): AcquireHostBuildSlotOptions {
  return { dir, maxBuilds: 2, repo: 'o/r', issue: 1, phase: 'build', ...over };
}

async function slotFiles(): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.startsWith('slot-')).sort();
}

describe('host build slots', () => {
  it('hostBuildSlotsDir nests under ~/.factory/host/build-slots', () => {
    expect(hostBuildSlotsDir('/h')).toBe('/h/.factory/host/build-slots');
  });

  it('two acquires take slot-0 and slot-1 and record the holder', async () => {
    const a = await acquireHostBuildSlot(opts({ issue: 1, pid: 111 }));
    const b = await acquireHostBuildSlot(opts({ issue: 2, phase: 'check', pid: 222 }));
    expect([a.slot, b.slot]).toEqual([0, 1]);
    const rec = JSON.parse(await readFile(join(dir, 'slot-1.json'), 'utf8'));
    expect(rec).toMatchObject({ pid: 222, repo: 'o/r', issue: 2, phase: 'check' });
    expect(typeof rec.token).toBe('string');
    expect(readHostBuildSlots(dir, 2).map((h) => h.issue)).toEqual([1, 2]);
    expect(await slotFiles()).toEqual(['slot-0.json', 'slot-1.json']);
    await a.release();
    await b.release();
  });

  it('a third acquire with the default host.maxBuilds waits while two slots are held', async () => {
    const maxBuilds = defaultFactoryConfig.host.maxBuilds;
    expect(maxBuilds).toBe(2);
    const a = await acquireHostBuildSlot(opts({ maxBuilds }));
    const b = await acquireHostBuildSlot(opts({ maxBuilds }));
    const logs: string[] = [];
    let sleeps = 0;
    let opened!: () => void;
    const gate = new Promise<void>((r) => (opened = r));
    const pending = acquireHostBuildSlot(
      opts({
        maxBuilds,
        issue: 3,
        log: (m) => logs.push(m),
        sleep: async () => {
          sleeps++;
          if (sleeps === 3) await a.release();
          if (sleeps === 1) opened();
          await new Promise((r) => setTimeout(r, 1));
        },
      }),
    );
    let third: Awaited<typeof pending> | undefined;
    void pending.then((l) => (third = l));
    await gate;
    expect(third).toBeUndefined();
    await pending;
    expect(logs).toEqual(['waiting for host build slot (2/2 in use)']);
    expect(third?.slot).toBe(0);
    await b.release();
    await third?.release();
  });

  it('withHostBuildSlot removes the slot file when fn resolves and when fn rejects, and a waiter then acquires it', async () => {
    const one = opts({ maxBuilds: 1 });
    await expect(
      withHostBuildSlot(one, async () => {
        expect(await slotFiles()).toEqual(['slot-0.json']);
        return 'ok';
      }),
    ).resolves.toBe('ok');
    expect(await slotFiles()).toEqual([]);

    await expect(
      withHostBuildSlot(one, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await slotFiles()).toEqual([]);

    const holder = await acquireHostBuildSlot(one);
    let got = false;
    const waiter = withHostBuildSlot({ ...one, pollMs: 5 }, async () => {
      got = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toBe(false);
    await holder.release();
    await waiter;
    expect(got).toBe(true);
    expect(await slotFiles()).toEqual([]);
  });

  it('release is idempotent and leaves a slot file owned by someone else', async () => {
    const lease = await acquireHostBuildSlot(opts());
    await lease.release();
    await lease.release();
    expect(await slotFiles()).toEqual([]);

    const mine = await acquireHostBuildSlot(opts());
    await writeFile(mine.file, JSON.stringify({ token: 'someone-else', pid: 9 }));
    await mine.release();
    expect(await slotFiles()).toEqual(['slot-0.json']);
  });

  it('counts an unparseable slot file as held', async () => {
    await writeFile(join(dir, 'slot-0.json'), 'not json');
    expect(readHostBuildSlots(dir, 2)).toEqual([expect.objectContaining({ slot: 0, pid: 0, repo: '' })]);
    const lease = await acquireHostBuildSlot(opts());
    expect(lease.slot).toBe(1);
    await lease.release();
  });

  it('rethrows non-EEXIST link failures and cleans up its temp file', async () => {
    await expect(acquireHostBuildSlot(opts({ dir: join(dir, 'x', '\0bad') }))).rejects.toThrow();
  });

  it('gateHostPhases runs BUILD and CHECK inside a slot and frees it afterwards', async () => {
    vi.stubEnv('FACTORY_HOST_SLOTS_DIR', dir);
    const held: string[][] = [];
    const snapshot = async () => void held.push(await slotFiles());
    const build = vi.fn(async (o: string) => (await snapshot(), `build:${o}`));
    const check = vi.fn(async (o: string) => (await snapshot(), `check:${o}`));
    const gated = gateHostPhases(
      { buildPhase: build, checkPhase: check } as never,
      loadFactoryConfig(),
      'o/r',
      7,
      vi.fn(),
    );
    await expect(gated.buildPhase('a' as never)).resolves.toBe('build:a');
    await expect(gated.checkPhase('b' as never)).resolves.toBe('check:b');
    expect(held).toEqual([['slot-0.json'], ['slot-0.json']]);
    expect(await slotFiles()).toEqual([]);
    vi.unstubAllEnvs();
  });
});
