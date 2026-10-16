// src/environment/load-guard.ts — Host load guard for new issue claims (#3048).

import { cpus as osCpus, loadavg as osLoadavg } from 'node:os';

import type { HostLoadGuardPolicy } from '../config/index.js';

export interface HostLoadSample {
  load5: number;
  cpus: number;
}

export type LoadGuardDecision =
  { kind: 'claim' } | { kind: 'hold'; load5: number; threshold: number; cpus: number; retryMs: number };

export const LOAD_GUARD_CPU_MULTIPLIER = 3;

/** Read the 5-minute load average and CPU count. os.loadavg() is [0,0,0] on Windows. */
export function readHostLoad(
  probe: { loadavg: () => number[]; cpus: () => readonly unknown[] } = { loadavg: osLoadavg, cpus: osCpus },
): HostLoadSample {
  return { load5: probe.loadavg()[1] ?? Number.NaN, cpus: probe.cpus().length };
}

export function loadGuardThreshold(policy: HostLoadGuardPolicy, cpus: number): number {
  return policy.maxLoad ?? LOAD_GUARD_CPU_MULTIPLIER * Math.max(1, cpus);
}

/** Hold only when the guard is on and load5 is finite and strictly above the threshold (fail open). */
export function evaluateLoadGuard(policy: HostLoadGuardPolicy, sample: HostLoadSample): LoadGuardDecision {
  if (!policy.enabled || !Number.isFinite(sample.load5)) return { kind: 'claim' };
  const threshold = loadGuardThreshold(policy, sample.cpus);
  return sample.load5 > threshold
    ? { kind: 'hold', load5: sample.load5, threshold, cpus: sample.cpus, retryMs: policy.retryMs }
    : { kind: 'claim' };
}

export function formatLoadHold(
  lane: string,
  hold: Extract<LoadGuardDecision, { kind: 'hold' }>,
  retryAt: Date,
): string {
  return `lane '${lane}' not claiming: host load ${hold.load5.toFixed(2)} (5-min avg) above threshold ${hold.threshold} (${hold.cpus} CPUs) — retrying at ${retryAt.toISOString()}`;
}
