// packages/cli/src/cli/disk-guard.ts — shared disk guard for lane claims and BUILD/CHECK starts (#2284)

import { existsSync } from 'node:fs';
import { hostname } from 'node:os';

import type { RunPorts } from '@on-par/factory-core';
import {
  claimDiskAlertSlot,
  evaluateDiskGuard,
  formatDiskLow,
  hostDiskAlertFile,
  logEvent,
  readFreeSpace,
} from '@on-par/factory-core/internal';
import type { DiskGuardDecision, DiskSample } from '@on-par/factory-core/internal';

import type { Notifier } from './notify.js';

export interface DiskGuardOptions {
  minFreeGb: number;
  paths: string[];
  retryMs: number;
  eventsFile: string;
  stopFile: string;
  emitEvent?: typeof logEvent;
  notifier?: Notifier;
  alertFile?: string;
  probe?: (path: string) => DiskSample;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  pathExists?: (p: string) => boolean;
  host?: string;
}

export interface DiskGuard {
  /** Samples every path. Emits disk_low / disk_recovered (and the alert) on episode transitions. */
  check(): DiskGuardDecision;
  /** Holds while free space is low, retrying every retryMs. Never parks or releases anything. */
  waitForSpace(scope: string, opts?: { observeStop?: boolean }): Promise<'ok' | 'stopped'>;
}

export function createDiskGuard(opts: DiskGuardOptions): DiskGuard {
  const {
    minFreeGb,
    paths,
    retryMs,
    eventsFile,
    stopFile,
    emitEvent = logEvent,
    notifier,
    alertFile,
    probe = (p) => readFreeSpace(p),
    sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now = () => new Date(),
    pathExists = existsSync,
    host = hostname(),
  } = opts;
  let low = false;

  const check = (): DiskGuardDecision => {
    if (minFreeGb <= 0) return { kind: 'ok', freeGb: null };
    try {
      const samples: DiskSample[] = [];
      for (const p of paths) {
        try {
          samples.push(probe(p));
        } catch {
          // an unreadable volume fails open
        }
      }
      const d = evaluateDiskGuard(minFreeGb, samples);
      if (d.kind === 'low' && !low) {
        low = true;
        const message = formatDiskLow(d);
        emitEvent(eventsFile, 'disk_low', 'all', message);
        const at = now();
        if (notifier && claimDiskAlertSlot(alertFile ?? hostDiskAlertFile(), at)) {
          notifier.notify({
            kind: 'disk_low',
            ts: at.toISOString(),
            host,
            message: `disk low: ${message}`,
            freeGb: d.freeGb,
            thresholdGb: d.thresholdGb,
            path: d.path,
          });
        }
      } else if (d.kind === 'ok' && low) {
        low = false;
        emitEvent(
          eventsFile,
          'disk_recovered',
          'all',
          `disk space recovered: free=${d.freeGb} GB threshold=${minFreeGb} GB`,
        );
      }
      return d;
    } catch {
      return { kind: 'ok', freeGb: null };
    }
  };

  const waitForSpace = async (scope: string, o: { observeStop?: boolean } = {}): Promise<'ok' | 'stopped'> => {
    const observeStop = o.observeStop ?? true;
    for (let d = check(); d.kind === 'low'; d = check()) {
      const retryAt = new Date(now().getTime() + retryMs).toISOString();
      emitEvent(eventsFile, 'warn', scope, `${scope} paused: disk low ${formatDiskLow(d)} — retrying at ${retryAt}`);
      await sleep(retryMs);
      if (observeStop && pathExists(stopFile)) return 'stopped';
    }
    return 'ok';
  };

  return { check, waitForSpace };
}

/** Wraps a host build-slot port so BUILD and CHECK wait for free disk before taking a slot (#2284).
 *  A running phase is never interrupted, and the wait holds no slot. */
export function diskGatedSlotPort(
  slotPort: NonNullable<RunPorts['hostBuildSlot']>,
  guard: Pick<DiskGuard, 'waitForSpace'> | undefined,
  issue: number,
): NonNullable<RunPorts['hostBuildSlot']> {
  if (!guard) return slotPort;
  return async (phase, fn) => {
    await guard.waitForSpace(`#${issue} before ${phase}`, { observeStop: false });
    return slotPort(phase, fn);
  };
}
