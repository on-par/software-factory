// packages/cli/src/cli/sweep-heartbeat.ts — detect a dead auto-merge-sweep loop from its
// heartbeat file's mtime, so `factory doctor`/`status` catch it instead of it rotting silently.

import { existsSync, statSync } from 'node:fs';
import type { DoctorCheck } from './doctor.js';

export interface SweepHeartbeatPolicy {
  heartbeatFile?: string;
  loopIntervalSeconds: number;
  staleThresholdMultiplier: number;
}

export interface SweepHeartbeatDeps {
  exists: (p: string) => boolean;
  mtimeMs: (p: string) => number;
  now: () => number;
}

export function defaultSweepHeartbeatDeps(): SweepHeartbeatDeps {
  return {
    exists: (p) => existsSync(p),
    mtimeMs: (p) => statSync(p).mtimeMs,
    now: () => Date.now(),
  };
}

export function resolveSweepHeartbeatFile(policy: SweepHeartbeatPolicy, env: NodeJS.ProcessEnv): string | undefined {
  return policy.heartbeatFile || env.HEARTBEAT_FILE || undefined;
}

export type SweepHeartbeatStatus =
  | { status: 'unconfigured' }
  | { status: 'missing'; file: string }
  | { status: 'fresh'; file: string; ageSeconds: number; thresholdSeconds: number }
  | { status: 'stale'; file: string; ageSeconds: number; thresholdSeconds: number };

export function checkSweepHeartbeat(
  policy: SweepHeartbeatPolicy,
  env: NodeJS.ProcessEnv,
  deps: SweepHeartbeatDeps,
): SweepHeartbeatStatus {
  const file = resolveSweepHeartbeatFile(policy, env);
  if (!file) return { status: 'unconfigured' };
  if (!deps.exists(file)) return { status: 'missing', file };

  const ageSeconds = Math.max(0, Math.round((deps.now() - deps.mtimeMs(file)) / 1000));
  const thresholdSeconds = Math.round(policy.loopIntervalSeconds * policy.staleThresholdMultiplier);

  return ageSeconds > thresholdSeconds
    ? { status: 'stale', file, ageSeconds, thresholdSeconds }
    : { status: 'fresh', file, ageSeconds, thresholdSeconds };
}

export function sweepHeartbeatCheck(status: SweepHeartbeatStatus): DoctorCheck | null {
  const NAME = 'auto-merge sweep heartbeat';
  switch (status.status) {
    case 'unconfigured':
      return null;
    case 'missing':
      return {
        name: NAME,
        ok: false,
        detail: `${status.file} not found — the sweep has never written a heartbeat`,
        fix: 'confirm the sweep loop is running and HEARTBEAT_FILE / sweep.heartbeatFile point at the right path',
      };
    case 'stale':
      return {
        name: NAME,
        ok: false,
        detail: `${status.file} last updated ${status.ageSeconds}s ago (> ${status.thresholdSeconds}s threshold) — the sweep looks dead`,
        fix: 'check the sweep loop / launchd job (see docs/runbooks/sweep-heartbeat.md) and restart it',
      };
    case 'fresh':
      return {
        name: NAME,
        ok: true,
        detail: `${status.file} updated ${status.ageSeconds}s ago (threshold ${status.thresholdSeconds}s)`,
      };
  }
}

export function formatSweepHeartbeatStatusLine(status: SweepHeartbeatStatus): string {
  switch (status.status) {
    case 'unconfigured':
      return 'not configured (sweep.heartbeatFile / HEARTBEAT_FILE unset)';
    case 'missing':
      return `MISSING — ${status.file} not found`;
    case 'stale':
      return `STALE — ${status.file}, last updated ${status.ageSeconds}s ago (threshold ${status.thresholdSeconds}s)`;
    case 'fresh':
      return `OK — ${status.file}, last updated ${status.ageSeconds}s ago (threshold ${status.thresholdSeconds}s)`;
  }
}
