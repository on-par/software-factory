// packages/cli/src/cli/kpi-sweep.test.ts — the end-of-run KPI snapshot skips no-op runs and degrades on a low budget

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getFactoryPaths, readEvents, reconstructKpiEvents } from '@on-par/factory-core';
import { fetchHumanEventSourcesCached } from '@on-par/factory-core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KPI_SWEEP_NOOP_MESSAGE, runEndOfRunKpiSnapshot } from './kpi-sweep.js';

const RUN_START = '2026-10-17T10:00:00.000Z';
const DURING = '2026-10-17T10:05:00.000Z';

let root: string;
let paths: ReturnType<typeof getFactoryPaths>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kpi-sweep-cli-'));
  paths = getFactoryPaths(root, join(root, '.factory'));
  mkdirSync(paths.state, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeEvents(...events: Array<{ type: string; ts: string; issue?: string }>): void {
  const lines = events.map((e) => JSON.stringify({ issue: '1', msg: '', ...e }));
  writeFileSync(paths.events, `${lines.join('\n')}\n`);
}

/** A counting GitHub client wired through the real cached sweep, so "0 sweep calls" is measured, not assumed. */
function countingRuntime(remaining = 5000) {
  const calls: string[] = [];
  const client: any = {
    rest: {
      rateLimit: {
        get: async () => {
          calls.push('rateLimit');
          return { data: { resources: { core: { limit: 5000, remaining } } } };
        },
      },
      pulls: {
        list: async () => {
          calls.push('list');
          return { data: [] };
        },
        listCommits: async () => (calls.push('listCommits'), { data: [] }),
        listReviews: async () => (calls.push('listReviews'), { data: [] }),
        get: async () => (calls.push('get'), { data: {} }),
      },
    },
  };
  const appendKpiSnapshot = vi.fn(async () => ({}));
  const rt = {
    readCosts: () => [],
    reconstructHumanEventsForKpis: vi.fn(async (events: any[], prefix: string) => ({
      ...(await reconstructKpiEvents(events, (issues) =>
        fetchHumanEventSourcesCached(client, 'o', 'r', issues, prefix, { cachePath: paths.kpiSweepCache }),
      )),
      owner: 'o',
      repoName: 'r',
    })),
    appendKpiSnapshot,
  };
  return { rt, calls, appendKpiSnapshot };
}

const loggedOfType = (type: string) => readEvents(paths.events).filter((e) => e.type === type);

describe('runEndOfRunKpiSnapshot', () => {
  it('a no-op run (claim/release/pause only) makes 0 sweep API calls and logs why', async () => {
    writeEvents(
      { type: 'merged', ts: '2026-10-17T09:00:00.000Z' }, // an earlier run's merge does not count
      { type: 'lane-start', ts: DURING },
      { type: 'lane-paused', ts: DURING },
      { type: 'parked', ts: DURING },
      { type: 'run-done', ts: DURING },
    );
    const { rt, calls, appendKpiSnapshot } = countingRuntime();
    await runEndOfRunKpiSnapshot(paths, root, 'factory', RUN_START, rt as any);
    expect(calls).toEqual([]);
    expect(rt.reconstructHumanEventsForKpis).not.toHaveBeenCalled();
    expect(appendKpiSnapshot).not.toHaveBeenCalled();
    expect(loggedOfType('kpi-sweep-skipped').map((e) => e.msg)).toEqual([KPI_SWEEP_NOOP_MESSAGE]);
  });

  it('a run that opened a PR sweeps and appends a snapshot', async () => {
    writeEvents({ type: 'pr_opened', ts: DURING });
    const { rt, calls, appendKpiSnapshot } = countingRuntime();
    await runEndOfRunKpiSnapshot(paths, root, 'factory', RUN_START, rt as any);
    expect(calls).toEqual(['rateLimit', 'list']);
    expect(appendKpiSnapshot).toHaveBeenCalledWith(paths, root, expect.anything(), { partial: false });
    expect(loggedOfType('kpi-snapshot')).toHaveLength(1);
  });

  it('when core remaining is under 20%, makes 0 sweep calls, logs the reason and marks the snapshot partial', async () => {
    writeEvents({ type: 'merged', ts: DURING });
    const { rt, calls, appendKpiSnapshot } = countingRuntime(100);
    await runEndOfRunKpiSnapshot(paths, root, 'factory', RUN_START, rt as any);
    expect(calls).toEqual(['rateLimit']); // GET /rate_limit does not count against the budget
    expect(appendKpiSnapshot).toHaveBeenCalledWith(paths, root, expect.anything(), { partial: true });
    const warns = loggedOfType('warn').map((e) => e.msg);
    expect(warns).toEqual([
      'kpi snapshot partial: GitHub human-event reconstruction failed: KPI sweep skipped: GitHub REST core budget low: 100/5000 remaining (< 20%)',
    ]);
  });

  it('logs and swallows a snapshot failure', async () => {
    writeEvents({ type: 'landed', ts: DURING });
    const { rt } = countingRuntime();
    rt.appendKpiSnapshot.mockRejectedValueOnce(new Error('disk full'));
    await runEndOfRunKpiSnapshot(paths, root, 'factory', RUN_START, rt as any);
    expect(loggedOfType('warn').map((e) => e.msg)).toEqual(['kpi snapshot failed: disk full']);
  });
});
