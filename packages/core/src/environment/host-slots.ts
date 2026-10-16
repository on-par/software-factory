// src/environment/host-slots.ts — Host-wide BUILD/CHECK slot leases (#3043). Every runner
// process on the machine shares one directory of slot files, so the number of lanes inside a
// BUILD or CHECK phase is capped no matter how many repos or supervisors are running. Slots whose
// holder pid is dead are reclaimed (#3044) under a per-slot arbiter.

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { link, mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { defaultIsPidAlive } from './index.js';

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
  /** Liveness probe for slot holders. Default: signal-0 defaultIsPidAlive; injectable for tests. */
  isPidAlive?: (pid: number) => boolean;
  /** Age after which a leftover `slot-N.reclaim` arbiter is reaped. Default 10000. */
  reclaimGraceMs?: number;
}

const DEFAULT_POLL_MS = 2000;
const DEFAULT_RECLAIM_GRACE_MS = 10_000;

/** Shared slot directory: `<home>/.factory/host/build-slots`. FACTORY_HOST_SLOTS_DIR overrides the default (tests). */
export function hostBuildSlotsDir(home?: string): string {
  const override = process.env.FACTORY_HOST_SLOTS_DIR;
  if (home === undefined && override) return override;
  return join(home ?? homedir(), '.factory', 'host', 'build-slots');
}

function slotFile(dir: string, slot: number): string {
  return join(dir, `slot-${slot}.json`);
}

function reclaimArbiter(dir: string, slot: number): string {
  return join(dir, `slot-${slot}.reclaim`);
}

/** Reads one slot file: null when missing, pid 0 when unparseable. */
async function readSlotHolder(file: string, slot: number): Promise<HostSlotHolder | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return { ...(JSON.parse(raw) as HostSlotHolder), slot };
  } catch {
    return { slot, pid: 0, repo: '', issue: 0, phase: 'build', token: '', acquiredAt: '' };
  }
}

/**
 * Removes a slot file whose holder is dead (ADR-0009 fenced steal). Only the winner of the atomic
 * `slot-N.reclaim` mkdir may delete another process's slot file, and only when the file still
 * carries the observed token and pid. No other code may delete a stale slot file directly.
 * Returns true when this call removed the lease.
 */
export async function reclaimStaleHostSlot(
  dir: string,
  observed: HostSlotHolder,
  graceMs = DEFAULT_RECLAIM_GRACE_MS,
): Promise<boolean> {
  const arbiter = reclaimArbiter(dir, observed.slot);
  try {
    await mkdir(arbiter);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw err;
    try {
      const { mtimeMs } = await stat(arbiter);
      // A reclaimer that crashed mid-steal must not wedge the slot.
      if (Date.now() - mtimeMs > graceMs) await rm(arbiter, { recursive: true, force: true });
    } catch (statErr) {
      if ((statErr as NodeJS.ErrnoException).code !== 'ENOENT') throw statErr;
    }
    return false;
  }
  try {
    const file = slotFile(dir, observed.slot);
    const current = await readSlotHolder(file, observed.slot);
    if (!current || current.token !== observed.token || current.pid !== observed.pid) return false;
    await unlink(file).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
    return true;
  } finally {
    await rm(arbiter, { recursive: true, force: true });
  }
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

/** One slot file as `factory status` shows it (#3045). */
export interface HostSlotStatus extends HostSlotHolder {
  /** Holder pid > 0 and not alive: shown as stale, not counted as in use. */
  stale: boolean;
  /** File could not be parsed (pid 0 fallback): still counted as held, matching acquire. */
  unreadable: boolean;
}

/** Lists every `slot-<N>.json` in `dir`, sorted by N, for read-only display. Never reclaims. Missing dir → []. */
export function listHostSlots(dir: string, isPidAlive: (pid: number) => boolean = defaultIsPidAlive): HostSlotStatus[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const slots = names
    .map((name) => /^slot-(\d+)\.json$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  const out: HostSlotStatus[] = [];
  for (const slot of slots) {
    let raw: string;
    try {
      raw = readFileSync(slotFile(dir, slot), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    try {
      const holder = { ...(JSON.parse(raw) as HostSlotHolder), slot };
      const stale = typeof holder.pid === 'number' && holder.pid > 0 && !isPidAlive(holder.pid);
      out.push({ ...holder, stale, unreadable: false });
    } catch {
      out.push({
        slot,
        pid: 0,
        repo: '',
        issue: 0,
        phase: 'build',
        token: '',
        acquiredAt: '',
        stale: false,
        unreadable: true,
      });
    }
  }
  return out;
}

/** Takes the first free slot, polling (and logging the held count when it changes) until one frees. */
export async function acquireHostBuildSlot(opts: AcquireHostBuildSlotOptions): Promise<HostBuildSlotLease> {
  const { dir, maxBuilds, log } = opts;
  const pid = opts.pid ?? process.pid;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const graceMs = opts.reclaimGraceMs ?? DEFAULT_RECLAIM_GRACE_MS;
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
        // link() is atomic and fails with EEXIST when the slot is held, so a slot never appears half-written.
        const tryLink = async (): Promise<boolean> => {
          try {
            await link(tmp, file);
            return true;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
            throw err;
          }
        };
        let taken = await tryLink();
        if (!taken) {
          const holder = await readSlotHolder(file, slot);
          if (!holder) {
            // The holder released between link and read.
            taken = await tryLink();
          } else if (
            holder.pid > 0 &&
            typeof holder.token === 'string' &&
            !isPidAlive(holder.pid) &&
            (await reclaimStaleHostSlot(dir, holder, graceMs))
          ) {
            log?.(
              `reclaimed host build slot ${slot} from ${holder.repo}#${holder.issue} (pid ${holder.pid}, not alive)`,
            );
            taken = await tryLink();
          }
        }
        if (!taken) continue;
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
