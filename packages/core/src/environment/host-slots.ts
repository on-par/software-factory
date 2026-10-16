// src/environment/host-slots.ts — Host-wide BUILD/CHECK slot leases (#3043). Every runner
// process on the machine shares one directory of slot files, so the number of lanes inside a
// BUILD or CHECK phase is capped no matter how many repos or supervisors are running.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface HostSlotHolder {
  slot: number;
  pid: number;
  repo: string;
  issue: number;
  phase: 'build' | 'check';
  token: string;
  acquiredAt: string;
}

export interface HostBuildSlotLease {
  slot: number;
  file: string;
  release(): Promise<void>;
}

export interface AcquireHostBuildSlotOptions {
  /** Usually hostBuildSlotsDir(). */
  dir: string;
  /** Host-wide cap (>= 1). */
  maxBuilds: number;
  repo: string;
  issue: number;
  phase: 'build' | 'check';
  log?: (message: string) => void;
  /** Poll interval while every slot is held. Default 2000. */
  pollMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Default process.pid. */
  pid?: number;
}

const DEFAULT_POLL_MS = 2000;

/** Shared slot directory: `<home>/.factory/host/build-slots`. FACTORY_HOST_SLOTS_DIR overrides the default (tests). */
export function hostBuildSlotsDir(home?: string): string {
  const override = process.env.FACTORY_HOST_SLOTS_DIR;
  if (home === undefined && override) return override;
  return join(home ?? homedir(), '.factory', 'host', 'build-slots');
}

function slotFile(dir: string, slot: number): string {
  return join(dir, `slot-${slot}.json`);
}

/** Reads slot-0 … slot-(maxBuilds-1). Missing files are free; an unparseable file counts as held. */
export function readHostBuildSlots(dir: string, maxBuilds: number): HostSlotHolder[] {
  const holders: HostSlotHolder[] = [];
  for (let slot = 0; slot < maxBuilds; slot++) {
    let raw: string;
    try {
      raw = readFileSync(slotFile(dir, slot), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    try {
      holders.push({ ...(JSON.parse(raw) as HostSlotHolder), slot });
    } catch {
      holders.push({ slot, pid: 0, repo: '', issue: 0, phase: 'build', token: '', acquiredAt: '' });
    }
  }
  return holders;
}

/** Takes the first free slot, polling (and logging the held count when it changes) until one frees. */
export async function acquireHostBuildSlot(opts: AcquireHostBuildSlotOptions): Promise<HostBuildSlotLease> {
  const { dir, maxBuilds, log } = opts;
  const pid = opts.pid ?? process.pid;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  await mkdir(dir, { recursive: true });

  const token = randomUUID();
  const tmp = join(dir, `.tmp-${pid}-${token}.json`);
  const record = {
    pid,
    repo: opts.repo,
    issue: opts.issue,
    phase: opts.phase,
    token,
    acquiredAt: new Date().toISOString(),
  };
  await writeFile(tmp, JSON.stringify(record));

  let lastLogged = -1;
  try {
    for (;;) {
      for (let slot = 0; slot < maxBuilds; slot++) {
        const file = slotFile(dir, slot);
        try {
          // link() is atomic and fails with EEXIST when the slot is held, so a slot never appears half-written.
          await link(tmp, file);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw err;
        }
        await unlink(tmp).catch(() => {});
        return { slot, file, release: () => releaseSlot(file, token) };
      }
      const held = Math.min(readHostBuildSlots(dir, maxBuilds).length, maxBuilds);
      if (held !== lastLogged) {
        lastLogged = held;
        log?.(`waiting for host build slot (${held}/${maxBuilds} in use)`);
      }
      await sleep(pollMs);
    }
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

async function releaseSlot(file: string, token: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  let current: string | undefined;
  try {
    current = (JSON.parse(raw) as { token?: string }).token;
  } catch {
    return;
  }
  if (current !== token) return;
  await unlink(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
}

/** Runs `fn` while holding a host build slot; the slot is freed when fn resolves or throws. */
export async function withHostBuildSlot<T>(opts: AcquireHostBuildSlotOptions, fn: () => Promise<T>): Promise<T> {
  const lease = await acquireHostBuildSlot(opts);
  try {
    return await fn();
  } finally {
    await lease.release();
  }
}
