// src/environment/disk-guard.ts — Host disk guard for claims and BUILD/CHECK phases (#2284).

import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { resolveDiskGuard, type DiskGuardPolicy } from '../config/disk-policy.js';
import type { FactoryConfig } from '../config/index.js';
import { resolveWorktreeRoot } from '../utils/worktree-location.js';

export const BYTES_PER_GB = 1024 ** 3;
export const DISK_ALERT_INTERVAL_MS = 60 * 60_000;

type StatfsFn = (path: string) => { bavail: number | bigint; bsize: number | bigint };

/** Lowest free space across the probed paths, plus the path that had it. */
export interface DiskSample {
  freeGb: number;
  path: string;
}

export type DiskGuardDecision =
  { kind: 'claim' } | { kind: 'hold'; freeGb: number; thresholdGb: number; path: string; retryMs: number };

export interface DiskGuard {
  readonly policy: DiskGuardPolicy;
  readonly paths: readonly string[];
  check(): DiskGuardDecision;
  status(): { freeGb: number; thresholdGb: number; low: boolean } | null;
}

function nearestExisting(path: string): string {
  let p = path;
  while (!existsSync(p)) {
    const parent = dirname(p);
    if (parent === p) break;
    p = parent;
  }
  return p;
}

/** Read free GiB for each path (walking up to the nearest existing ancestor); null when none is readable. */
export function readDiskFree(paths: readonly string[], statfs: StatfsFn = statfsSync): DiskSample | null {
  let lowest: DiskSample | null = null;
  for (const path of paths) {
    try {
      const s = statfs(nearestExisting(path));
      const freeGb = (Number(s.bavail) * Number(s.bsize)) / BYTES_PER_GB;
      if (!Number.isFinite(freeGb)) continue;
      if (!lowest || freeGb < lowest.freeGb) lowest = { freeGb, path };
    } catch {
      // unreadable path: skip, fail open
    }
  }
  return lowest;
}

/** Hold only when the guard is on and free space is finite and strictly below the threshold (fail open). */
export function evaluateDiskGuard(policy: DiskGuardPolicy, sample: DiskSample | null): DiskGuardDecision {
  if (!policy.enabled || !sample || !Number.isFinite(sample.freeGb)) return { kind: 'claim' };
  return sample.freeGb < policy.minFreeGb
    ? { kind: 'hold', freeGb: sample.freeGb, thresholdGb: policy.minFreeGb, path: sample.path, retryMs: policy.retryMs }
    : { kind: 'claim' };
}

export function formatDiskHold(
  scope: string,
  hold: Extract<DiskGuardDecision, { kind: 'hold' }>,
  retryAt: Date,
): string {
  return `${scope} disk low — free=${hold.freeGb.toFixed(1)} GB threshold=${hold.thresholdGb} GB path=${hold.path} — retrying at ${retryAt.toISOString()}`;
}

export function hostDiskAlertFile(home: string = homedir()): string {
  return join(home, '.factory', 'host', 'disk-alert.json');
}

/** True when an alert may be sent now (and records it); false when one went out within intervalMs. */
export function claimDiskAlert(file: string, now: Date, intervalMs: number = DISK_ALERT_INTERVAL_MS): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const last = parsed && typeof parsed === 'object' && 'lastAlertAt' in parsed ? parsed.lastAlertAt : undefined;
    const lastMs = typeof last === 'string' ? Date.parse(last) : Number.NaN;
    if (Number.isFinite(lastMs) && now.getTime() - lastMs < intervalMs) return false;
  } catch {
    // missing or garbage file counts as no prior alert
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ lastAlertAt: now.toISOString() }));
    renameSync(tmp, file);
  } catch {
    // fail open to alerting
  }
  return true;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The only place that combines worktree root, policy and a disk sample. */
export function createDiskGuard(
  config: FactoryConfig,
  ctx: { repoRoot: string; ghRepo: string; stateRoot: string; env?: NodeJS.ProcessEnv; statfs?: StatfsFn },
): DiskGuard {
  const policy = resolveDiskGuard(config, ctx.env);
  const paths = [
    resolveWorktreeRoot({ repoRoot: ctx.repoRoot, parent: config.worktree.parent, repo: ctx.ghRepo }),
    ctx.stateRoot,
  ];
  return {
    policy,
    paths,
    check: () => evaluateDiskGuard(policy, policy.enabled ? readDiskFree(paths, ctx.statfs) : null),
    status: () => {
      const sample = readDiskFree(paths, ctx.statfs);
      if (!sample) return null;
      return {
        freeGb: round1(sample.freeGb),
        thresholdGb: policy.minFreeGb,
        low: policy.enabled && sample.freeGb < policy.minFreeGb,
      };
    },
  };
}
