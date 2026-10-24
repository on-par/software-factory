// packages/cli/src/cli/kpi-sweep.ts — the end-of-run KPI snapshot, skipped on runs that opened no PR and merged nothing

import { existsSync } from 'node:fs';

import { computeHealthKpis, readEvents } from '@on-par/factory-core';
import { logEvent, runProducedPrOrMerge } from '@on-par/factory-core/internal';

import type { RunRuntime } from './run.js';

export const KPI_SWEEP_NOOP_MESSAGE = 'KPI sweep skipped: this run opened no PR and merged nothing';

/** Appends a KPI snapshot after `factory run`. A run that only claimed, released or paused is skipped
 *  with a `kpi-sweep-skipped` event: its GitHub sweep would cost REST calls and change nothing. */
export async function runEndOfRunKpiSnapshot(
  paths: Parameters<RunRuntime['appendKpiSnapshot']>[0],
  repoRoot: string,
  branchPrefix: string,
  runStartedAt: string,
  rt: Pick<RunRuntime, 'readCosts' | 'reconstructHumanEventsForKpis' | 'appendKpiSnapshot'>,
): Promise<void> {
  try {
    const events = readEvents(paths.events, { includeSegments: true });
    if (!runProducedPrOrMerge(events, runStartedAt)) {
      logEvent(paths.events, 'kpi-sweep-skipped', 'all', KPI_SWEEP_NOOP_MESSAGE);
      return;
    }
    const costs = existsSync(paths.costs) ? rt.readCosts(paths.costs) : [];
    const recon = await rt.reconstructHumanEventsForKpis(events, branchPrefix);
    const kpis = computeHealthKpis(recon.events, costs);
    await rt.appendKpiSnapshot(paths, repoRoot, kpis, { partial: recon.partial });
    if (recon.partial) {
      logEvent(
        paths.events,
        'warn',
        'all',
        `kpi snapshot partial: GitHub human-event reconstruction failed: ${recon.error}`,
      );
    }
    logEvent(paths.events, 'kpi-snapshot', 'all', `KPI snapshot appended to ${paths.kpiHistory}`);
  } catch (err: any) {
    logEvent(paths.events, 'warn', 'all', `kpi snapshot failed: ${err.message}`);
  }
}
