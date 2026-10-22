// packages/core/src/queue/claim-race.test.ts — multi-host claim races over the GitHub label queue (#3150, epic #3141).

import { describe, expect, it } from 'vitest';
import { laneLabel, queueOrderLabel, QUEUED_LABEL } from './github-queue.js';
import {
  exploreExhaustive,
  exploreSeeded,
  formatFleetFailure,
  replayFleetSchedule,
  type FleetIssueSeed,
  type FleetScenario,
} from './test-support/fleet-sim.js';

function seedIssues(count: number): FleetIssueSeed[] {
  return Array.from({ length: count }, (_, i) => ({
    number: i + 1,
    labels: [QUEUED_LABEL, laneLabel('main'), queueOrderLabel(i + 1)],
  }));
}

const twoByOne: FleetScenario = { issues: seedIssues(1), claimants: ['host-a', 'host-b'] };

describe('claim race (fleet-sim)', () => {
  // Marked `fails` until #3145 lands, then flip to `it`. Failing schedule: host-a reads the issue as eligible,
  // host-b claims it, host-a adds its labels and, being the smaller id, also wins.
  it.fails('exhaustive 2 claimants x 1 issue finds no double claim', async () => {
    const r = await exploreExhaustive(twoByOne, { dedupeStates: true });
    expect(
      r.failures.flatMap((f) => f.violations),
      r.failures.map(formatFleetFailure).join('\n'),
    ).toEqual([]);
  });

  it('exhaustive 2 claimants x 1 issue covers every interleaving under 10 s', async () => {
    const start = performance.now();
    const r = await exploreExhaustive(twoByOne, { stopOnFirstViolation: false, dedupeStates: true });
    expect(r.truncated).toBe(false);
    expect(r.schedules).toBeGreaterThan(1);
    expect(performance.now() - start).toBeLessThan(10_000);
  }, 20_000);

  it('seeded 1000 schedules of 3 claimants x 5 issues under 30 s', async () => {
    const scenario: FleetScenario = { issues: seedIssues(5), claimants: ['host-a', 'host-b', 'host-c'] };
    const start = performance.now();
    const r = await exploreSeeded(scenario, { seed: 3150, schedules: 1000, stopOnFirstViolation: false });
    expect(performance.now() - start).toBeLessThan(30_000);
    expect(r.schedules).toBe(1000);
    const failure = r.failures[0];
    if (failure) {
      const text = formatFleetFailure(failure);
      expect(text).toContain('seed=');
      expect(text).toContain('replay:');
      const replay = await replayFleetSchedule(scenario, failure.choices);
      expect(replay.trace).toEqual(failure.trace);
    }
  }, 60_000);

  it('exhaustive 2 claimants x 1 issue with replica lag 1 completes', async () => {
    const r = await exploreExhaustive(
      { ...twoByOne, replicaLag: 1 },
      { stopOnFirstViolation: false, dedupeStates: true },
    );
    expect(r.truncated).toBe(false);
  }, 20_000);
});
