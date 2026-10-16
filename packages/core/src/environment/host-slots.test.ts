import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultFactoryConfig } from '@on-par/factory-config';

import {
  acquireHostBuildSlot,
  hostBuildSlotsDir,
  listHostSlots,
  readHostBuildSlots,
  reclaimStaleHostSlot,
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
    const a = await acquireHostBuildSlot(opts({ issue: 1, pid: 111, isPidAlive: () => true }));
    const b = await acquireHostBuildSlot(opts({ issue: 2, phase: 'check', pid: 222, isPidAlive: () => true }));
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
});

function holderRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: 4242,
    repo: 'o/dead',
    issue: 12,
    phase: 'build',
    token: 't0',
    acquiredAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('reclaiming slots of dead holders (#3044)', () => {
  it('reclaims a slot whose holder pid is not alive and logs the previous holder', async () => {
    await writeFile(join(dir, 'slot-0.json'), JSON.stringify(holderRecord()));
    await writeFile(join(dir, 'slot-1.json'), JSON.stringify(holderRecord({ pid: 4243, token: 't1' })));
    const logs: string[] = [];
    const lease = await acquireHostBuildSlot(
      opts({
        isPidAlive: (p) => p !== 4242 && p !== 4243,
        log: (m) => logs.push(m),
        sleep: async () => {
          throw new Error('should not wait');
        },
      }),
    );
    expect(lease.slot).toBe(0);
    expect(logs).toContain('reclaimed host build slot 0 from o/dead#12 (pid 4242, not alive)');
    const rec = JSON.parse(await readFile(join(dir, 'slot-0.json'), 'utf8'));
    expect(rec.token).not.toBe('t0');
    expect(await slotFiles()).toEqual(['slot-0.json', 'slot-1.json']);
    await lease.release();
  });

  it('never reclaims a live or unparseable holder', async () => {
    await writeFile(join(dir, 'slot-0.json'), JSON.stringify(holderRecord()));
    await writeFile(join(dir, 'slot-1.json'), 'not json');
    await expect(
      acquireHostBuildSlot(
        opts({
          isPidAlive: () => true,
          sleep: async () => {
            throw new Error('waited');
          },
        }),
      ),
    ).rejects.toThrow('waited');
    await expect(
      acquireHostBuildSlot(
        opts({
          maxBuilds: 1,
          isPidAlive: () => false,
          sleep: async () => {
            throw new Error('waited');
          },
        }),
      ),
    ).resolves.toMatchObject({ slot: 0 });
    await writeFile(join(dir, 'slot-1.json'), 'not json');
    await expect(
      acquireHostBuildSlot(
        opts({
          isPidAlive: () => false,
          sleep: async () => {
            throw new Error('waited');
          },
        }),
      ),
    ).resolves.toMatchObject({ slot: 0 });
    expect(await readFile(join(dir, 'slot-1.json'), 'utf8')).toBe('not json');
  });

  it('reclaimStaleHostSlot leaves a re-acquired slot alone', async () => {
    await writeFile(join(dir, 'slot-0.json'), JSON.stringify(holderRecord({ token: 't9' })));
    const observed = { slot: 0, ...holderRecord() } as never;
    await expect(reclaimStaleHostSlot(dir, observed)).resolves.toBe(false);
    expect(JSON.parse(await readFile(join(dir, 'slot-0.json'), 'utf8')).token).toBe('t9');
    expect(await slotFiles()).toEqual(['slot-0.json']);
    await rm(join(dir, 'slot-0.json'));
    await expect(reclaimStaleHostSlot(dir, observed)).resolves.toBe(false);
  });

  it('reclaimStaleHostSlot backs off while another reclaimer holds a fresh arbiter, and reaps one older than graceMs', async () => {
    await writeFile(join(dir, 'slot-0.json'), JSON.stringify(holderRecord()));
    const observed = { slot: 0, ...holderRecord() } as never;
    await mkdir(join(dir, 'slot-0.reclaim'));
    await expect(reclaimStaleHostSlot(dir, observed)).resolves.toBe(false);
    expect(await slotFiles()).toEqual(['slot-0.json', 'slot-0.reclaim']);
    await new Promise((r) => setTimeout(r, 10));
    await expect(reclaimStaleHostSlot(dir, observed, 0)).resolves.toBe(false);
    expect(await slotFiles()).toEqual(['slot-0.json']);
    await expect(reclaimStaleHostSlot(dir, observed)).resolves.toBe(true);
    expect(await slotFiles()).toEqual([]);
  });

  it('two in-process acquires racing on one stale slot (maxBuilds 1) reclaim it once and never both hold it', async () => {
    await writeFile(join(dir, 'slot-0.json'), JSON.stringify(holderRecord()));
    const logs: string[] = [];
    let active = 0;
    let peak = 0;
    let done = 0;
    const run = (issue: number) =>
      withHostBuildSlot(
        opts({ maxBuilds: 1, issue, pollMs: 5, isPidAlive: (p) => p !== 4242, log: (m) => logs.push(m) }),
        async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 30));
          active--;
          done++;
        },
      );
    await Promise.all([run(1), run(2)]);
    expect(peak).toBe(1);
    expect(done).toBe(2);
    expect(logs.filter((m) => m.startsWith('reclaimed'))).toHaveLength(1);
    expect(await slotFiles()).toEqual([]);
  });
});

describe('listHostSlots (#3045)', () => {
  const write = (name: string, body: unknown): Promise<void> =>
    writeFile(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  const holder = (pid: number, issue: number) => ({
    pid,
    repo: 'o/r',
    issue,
    phase: 'build',
    token: 't',
    acquiredAt: '',
  });

  it('returns [] for a missing dir', () => {
    expect(listHostSlots(join(dir, 'nope'))).toEqual([]);
  });

  it('lists only slot-N.json files, sorted by N', async () => {
    await write('slot-3.json', holder(1, 3));
    await write('slot-0.json', holder(1, 0));
    await write('slot-1.json', holder(1, 1));
    await write('.tmp-1-x.json', holder(1, 9));
    await mkdir(join(dir, 'slot-0.reclaim'));
    expect(listHostSlots(dir, () => true).map((s) => s.slot)).toEqual([0, 1, 3]);
  });

  it('marks only the dead holder stale', async () => {
    await write('slot-0.json', holder(111, 1));
    await write('slot-1.json', holder(222, 2));
    const slots = listHostSlots(dir, (pid) => pid !== 111);
    expect(slots.map((s) => s.stale)).toEqual([true, false]);
  });

  it('flags an unparseable file as unreadable and not stale', async () => {
    await write('slot-0.json', 'not json');
    expect(listHostSlots(dir, () => false)).toMatchObject([{ slot: 0, unreadable: true, stale: false }]);
  });
});
