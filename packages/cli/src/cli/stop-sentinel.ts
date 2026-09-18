// packages/cli/src/cli/stop-sentinel.ts — `.factory/STOP` presence as pure
// state, shared by `factory run`'s skip-and-log path and `factory doctor`'s
// explicit status row. STOP is never written or deleted from this module.

import { existsSync, statSync } from 'node:fs';
import type { DoctorCheck } from './doctor.js';

export interface StopFileDeps {
  pathExists: (p: string) => boolean;
  statMtimeMs: (p: string) => number;
  now: () => number;
}

export function defaultStopFileDeps(): StopFileDeps {
  return {
    pathExists: (p) => existsSync(p),
    statMtimeMs: (p) => statSync(p).mtimeMs,
    now: () => Date.now(),
  };
}

export type StopSentinelStatus = { present: false } | { present: true; ageMs: number; writtenAt: string };

export function readStopFileStatus(paths: { stop: string }, deps: Partial<StopFileDeps> = {}): StopSentinelStatus {
  const { pathExists, statMtimeMs, now } = { ...defaultStopFileDeps(), ...deps };
  if (!pathExists(paths.stop)) return { present: false };
  try {
    const mtimeMs = statMtimeMs(paths.stop);
    return { present: true, ageMs: Math.max(0, now() - mtimeMs), writtenAt: new Date(mtimeMs).toISOString() };
  } catch {
    return { present: true, ageMs: 0, writtenAt: 'unknown' };
  }
}

/** Human-readable age like "3h 12m", "45s", or "820ms". */
export function formatStopFileAge(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Message logged/printed by `factory run` when it skips a pass because STOP is present. */
export function stopSentinelRunSkipMessage(status: StopSentinelStatus): string {
  if (!status.present) return '';
  return (
    `.factory/STOP present (age ${formatStopFileAge(status.ageMs)}, written ${status.writtenAt}) — ` +
    `factory run is skipping this pass and claiming no new work. ` +
    `Remove .factory/STOP (or run \`factory resume\`) to continue.`
  );
}

export function stopSentinelCheck(status: StopSentinelStatus): DoctorCheck {
  if (!status.present) {
    return {
      name: 'STOP sentinel',
      ok: true,
      detail: '.factory/STOP not present — factory run will claim work normally',
    };
  }
  return {
    name: 'STOP sentinel',
    ok: false,
    optional: true,
    detail: `.factory/STOP present (age ${formatStopFileAge(status.ageMs)}, written ${status.writtenAt}) — repo is intentionally paused`,
    fix: 'rm .factory/STOP, or run `factory resume`, to let factory run claim work again',
  };
}
