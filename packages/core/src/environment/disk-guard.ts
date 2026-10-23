// src/environment/disk-guard.ts — Disk guard for new claims and BUILD/CHECK starts (#2284).

import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

import { defaultFactoryConfig } from '@on-par/factory-config';

import type { FactoryConfig } from '../config/index.js';

export interface DiskSample {
  path: string;
  freeBytes: number;
}

export type DiskGuardDecision =
  { kind: 'ok'; freeGb: number | null } | { kind: 'low'; freeGb: number; thresholdGb: number; path: string };

const GIB = 1024 ** 3;
const ALERT_INTERVAL_MS = 3_600_000;

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Free bytes available to unprivileged users on the volume holding `path`. A path that does not
 *  exist yet is measured through its nearest existing ancestor. Errors from statfs propagate. */
export function readFreeSpace(
  path: string,
  statfs: (p: string) => { bavail: number | bigint; bsize: number | bigint } = statfsSync,
  exists: (p: string) => boolean = existsSync,
): DiskSample {
  let p = path;
  while (!exists(p)) {
    const parent = dirname(p);
    if (parent === p) break;
    p = parent;
  }
  const s = statfs(p);
  return { path, freeBytes: Number(s.bavail) * Number(s.bsize) };
}

/** Low only when the guard is on and the emptiest sample is strictly below minFreeGb (GiB). */
export function evaluateDiskGuard(minFreeGb: number, samples: readonly DiskSample[]): DiskGuardDecision {
  let min: DiskSample | undefined;
  for (const s of samples) if (!min || s.freeBytes < min.freeBytes) min = s;
  if (!min) return { kind: 'ok', freeGb: null };
  const freeGb = round1(min.freeBytes / GIB);
  if (minFreeGb <= 0 || !Number.isFinite(minFreeGb)) return { kind: 'ok', freeGb };
  if (min.freeBytes < minFreeGb * GIB) return { kind: 'low', freeGb, thresholdGb: minFreeGb, path: min.path };
  return { kind: 'ok', freeGb };
}

export function formatDiskLow(d: Extract<DiskGuardDecision, { kind: 'low' }>): string {
  return `free=${d.freeGb.toFixed(1)} GB threshold=${d.thresholdGb} GB path=${d.path}`;
}

export function hostDiskAlertFile(home?: string): string {
  const override = process.env.FACTORY_HOST_DISK_ALERT_FILE;
  if (home === undefined && override) return override;
  return join(home ?? homedir(), '.factory', 'host', 'disk-alert.json');
}

/** True when an alert may be sent now (and records it). At most one per interval per host. */
export function claimDiskAlertSlot(file: string, now: Date, intervalMs: number = ALERT_INTERVAL_MS): boolean {
  try {
    const last = Date.parse((JSON.parse(readFileSync(file, 'utf8')) as { lastAlertAt?: string }).lastAlertAt ?? '');
    if (Number.isFinite(last) && now.getTime() - last < intervalMs) return false;
  } catch {
    // missing or garbled stamp counts as never alerted
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ lastAlertAt: now.toISOString(), host: hostname() }));
  } catch {
    // a full disk must not block the alert
  }
  return true;
}

/** Disk guard threshold in GiB (#2284). FACTORY_MIN_FREE_GB beats disk.minFreeGb; 0 turns the guard off.
 *  A blank, malformed or negative env value is ignored. */
export function resolveDiskMinFreeGb(config: FactoryConfig, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FACTORY_MIN_FREE_GB?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return config.disk?.minFreeGb ?? defaultFactoryConfig.disk.minFreeGb;
}
