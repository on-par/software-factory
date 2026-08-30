import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readEvents } from '../events/index.js';
import type { CostEntry, FactoryEvent } from '../types/index.js';
import { readCosts } from '../utils/index.js';
import {
  computeSandboxAbReport,
  DOCKER_SANDBOX_RUNTIME,
  recommendSandboxAb,
  renderSandboxAbReport,
  type SandboxAbCohortMetrics,
} from './sandbox-ab.js';

function cost(overrides: Partial<CostEntry> = {}): CostEntry {
  return {
    ts: '2026-07-20T00:00:00.000Z',
    issue: '1',
    task: 'build_claude',
    model: 'stub-model',
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    ...overrides,
  };
}

function event(overrides: Partial<FactoryEvent> = {}): FactoryEvent {
  return {
    ts: '2026-07-20T00:00:00.000Z',
    type: 'issue-title',
    issue: '1',
    msg: '',
    ...overrides,
  };
}

function fullCohort(overrides: Partial<SandboxAbCohortMetrics> = {}): SandboxAbCohortMetrics {
  return {
    runs: 3,
    meanWallClockMs: 1000,
    wallClockScoredRuns: 3,
    meanReworkRounds: 0,
    reworkScoredRuns: 3,
    sandboxViolations: 0,
    resourceLimits: 0,
    ciPassRate: 1,
    ciVerdictRuns: 3,
    ...overrides,
  };
}

describe('computeSandboxAbReport', () => {
  it('splits runs into docker/baseline/unknown cohorts by resolved sandboxRuntime', () => {
    const costs: CostEntry[] = [
      cost({ issue: '1', sandboxRuntime: DOCKER_SANDBOX_RUNTIME }),
      cost({ issue: '2', sandboxRuntime: 'sandbox-exec' }),
      cost({ issue: '3', sandboxRuntime: 'none' }),
      cost({ issue: '4' }),
    ];

    const report = computeSandboxAbReport([], costs);

    expect(report.docker.runs).toBe(1);
    expect(report.baseline.runs).toBe(2);
    expect(report.unknownRuns).toBe(1);
  });

  it('does not bucket an unknown run as baseline', () => {
    const costs: CostEntry[] = [cost({ issue: '5' })];
    const report = computeSandboxAbReport([], costs);
    expect(report.docker.runs).toBe(0);
    expect(report.baseline.runs).toBe(0);
    expect(report.unknownRuns).toBe(1);
  });

  it('sums duration and MAXes reworkRoundCount per run', () => {
    const costs: CostEntry[] = [
      cost({ issue: '1', sandboxRuntime: DOCKER_SANDBOX_RUNTIME, duration: 1000, reworkRoundCount: 1 }),
      cost({ issue: '1', sandboxRuntime: DOCKER_SANDBOX_RUNTIME, duration: 500, reworkRoundCount: 3 }),
    ];

    const report = computeSandboxAbReport([], costs);

    expect(report.docker.meanWallClockMs).toBe(1500);
    expect(report.docker.wallClockScoredRuns).toBe(1);
    expect(report.docker.meanReworkRounds).toBe(3);
    expect(report.docker.reworkScoredRuns).toBe(1);
  });

  it('attributes sandbox_violation/resource_limit events to the right cohort by issue', () => {
    const costs: CostEntry[] = [
      cost({ issue: '1', sandboxRuntime: DOCKER_SANDBOX_RUNTIME }),
      cost({ issue: '2', sandboxRuntime: 'none' }),
    ];
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'sandbox_violation' }),
      event({ issue: '1', type: 'sandbox_violation' }),
      event({ issue: '1', type: 'resource_limit' }),
      event({ issue: '2', type: 'sandbox_violation' }),
    ];

    const report = computeSandboxAbReport(events, costs);

    expect(report.docker.sandboxViolations).toBe(2);
    expect(report.docker.resourceLimits).toBe(1);
    expect(report.baseline.sandboxViolations).toBe(1);
    expect(report.baseline.resourceLimits).toBe(0);
  });

  it('computes CI pass rate from merged/human-merged vs ci-failed events, final outcome wins', () => {
    const costs: CostEntry[] = [
      cost({ issue: '1', sandboxRuntime: DOCKER_SANDBOX_RUNTIME }),
      cost({ issue: '2', sandboxRuntime: DOCKER_SANDBOX_RUNTIME }),
      cost({ issue: '3', sandboxRuntime: DOCKER_SANDBOX_RUNTIME }),
    ];
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'merged' }),
      event({ issue: '2', type: 'ci-failed' }),
      // issue 3: ci-failed first, then merged later — final outcome wins.
      event({ issue: '3', type: 'ci-failed' }),
      event({ issue: '3', type: 'merged' }),
    ];

    const report = computeSandboxAbReport(events, costs);

    expect(report.docker.ciVerdictRuns).toBe(3);
    expect(report.docker.ciPassRate).toBeCloseTo(2 / 3);
  });

  it('counts human-merged as a CI pass', () => {
    const costs: CostEntry[] = [cost({ issue: '1', sandboxRuntime: DOCKER_SANDBOX_RUNTIME })];
    const events: FactoryEvent[] = [event({ issue: '1', type: 'human-merged' })];

    const report = computeSandboxAbReport(events, costs);

    expect(report.docker.ciPassRate).toBe(1);
  });

  it('reports null (never 0) for an empty cohort', () => {
    const costs: CostEntry[] = [cost({ issue: '1', sandboxRuntime: DOCKER_SANDBOX_RUNTIME })];
    const report = computeSandboxAbReport([], costs);

    expect(report.baseline.runs).toBe(0);
    expect(report.baseline.meanWallClockMs).toBeNull();
    expect(report.baseline.meanReworkRounds).toBeNull();
    expect(report.baseline.ciPassRate).toBeNull();
    expect(report.docker.meanWallClockMs).toBeNull();
    expect(report.docker.meanReworkRounds).toBeNull();
    expect(report.docker.ciPassRate).toBeNull();
  });

  it('only attributes events to issues that have a cost row', () => {
    const costs: CostEntry[] = [cost({ issue: '1', sandboxRuntime: DOCKER_SANDBOX_RUNTIME })];
    const events: FactoryEvent[] = [event({ issue: 'no-cost-row', type: 'sandbox_violation' })];

    const report = computeSandboxAbReport(events, costs);

    expect(report.docker.sandboxViolations).toBe(0);
    expect(report.baseline.sandboxViolations).toBe(0);
  });
});

describe('recommendSandboxAb', () => {
  it('returns insufficient-data when either cohort has zero runs', () => {
    const { recommendation, rationale } = recommendSandboxAb(fullCohort(), fullCohort({ runs: 0 }));
    expect(recommendation).toBe('insufficient-data');
    expect(rationale.length).toBeGreaterThan(0);
  });

  it('returns drop when docker CI pass rate is more than the tolerance below baseline', () => {
    const docker = fullCohort({ ciPassRate: 0.5 });
    const baseline = fullCohort({ ciPassRate: 1 });
    const { recommendation, rationale } = recommendSandboxAb(docker, baseline);
    expect(recommendation).toBe('drop');
    expect(rationale.length).toBeGreaterThan(0);
  });

  it('returns flip-default when docker matches baseline CI with no regression', () => {
    const docker = fullCohort({ ciPassRate: 1, meanWallClockMs: 1000, meanReworkRounds: 0 });
    const baseline = fullCohort({ ciPassRate: 1, meanWallClockMs: 1000, meanReworkRounds: 0 });
    const { recommendation, rationale } = recommendSandboxAb(docker, baseline);
    expect(recommendation).toBe('flip-default');
    expect(rationale.length).toBeGreaterThan(0);
  });

  it('returns keep-opt-in when docker wall-clock regresses beyond the ratio', () => {
    const docker = fullCohort({ ciPassRate: 1, meanWallClockMs: 10000, meanReworkRounds: 0 });
    const baseline = fullCohort({ ciPassRate: 1, meanWallClockMs: 1000, meanReworkRounds: 0 });
    const { recommendation, rationale } = recommendSandboxAb(docker, baseline);
    expect(recommendation).toBe('keep-opt-in');
    expect(rationale).toContain('wall-clock');
  });

  it('returns keep-opt-in when docker rework rounds regress beyond the delta', () => {
    const docker = fullCohort({ ciPassRate: 1, meanWallClockMs: 1000, meanReworkRounds: 2 });
    const baseline = fullCohort({ ciPassRate: 1, meanWallClockMs: 1000, meanReworkRounds: 0 });
    const { recommendation, rationale } = recommendSandboxAb(docker, baseline);
    expect(recommendation).toBe('keep-opt-in');
    expect(rationale).toContain('rework');
  });

  it('returns keep-opt-in when CI pass rate is unknown for one cohort', () => {
    const docker = fullCohort({ ciPassRate: null, ciVerdictRuns: 0 });
    const baseline = fullCohort({ ciPassRate: 1 });
    const { recommendation, rationale } = recommendSandboxAb(docker, baseline);
    expect(recommendation).toBe('keep-opt-in');
    expect(rationale).toContain('CI pass rate unknown');
  });
});

describe('renderSandboxAbReport', () => {
  it('includes all four metric labels and a Recommendation line', () => {
    const report = computeSandboxAbReport(
      [event({ issue: '1', type: 'merged' })],
      [cost({ issue: '1', sandboxRuntime: DOCKER_SANDBOX_RUNTIME, duration: 100, reworkRoundCount: 0 })],
    );

    const rendered = renderSandboxAbReport(report);

    expect(rendered).toContain('mean wall-clock');
    expect(rendered).toContain('mean rework rounds');
    expect(rendered).toContain('sandbox_violation events');
    expect(rendered).toContain('resource_limit events');
    expect(rendered).toContain('CI pass rate');
    expect(rendered).toMatch(/^Recommendation:/m);
  });

  it('reports unknownRuns when present', () => {
    const report = computeSandboxAbReport([], [cost({ issue: '1' })]);
    const rendered = renderSandboxAbReport(report);
    expect(rendered).toContain('unknown runs');
  });
});

describe('computeSandboxAbReport (file-based fixture)', () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('reads costs.jsonl/events.ndjson and produces per-cohort aggregates plus a recommendation', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'sandbox-ab-'));
    const costsFile = join(tmpDir, 'costs.jsonl');
    const eventsFile = join(tmpDir, 'events.ndjson');

    const costs: CostEntry[] = [
      cost({ issue: '1', sandboxRuntime: DOCKER_SANDBOX_RUNTIME, duration: 1000, reworkRoundCount: 0 }),
      cost({ issue: '2', sandboxRuntime: DOCKER_SANDBOX_RUNTIME, duration: 1200, reworkRoundCount: 1 }),
      cost({ issue: '3', sandboxRuntime: 'sandbox-exec', duration: 900, reworkRoundCount: 0 }),
      cost({ issue: '4', sandboxRuntime: 'none', duration: 1100, reworkRoundCount: 0 }),
      cost({ issue: '5' }),
    ];
    const events: FactoryEvent[] = [
      event({ issue: '1', type: 'merged' }),
      event({ issue: '2', type: 'merged' }),
      event({ issue: '3', type: 'merged' }),
      event({ issue: '4', type: 'merged' }),
    ];

    await writeFile(costsFile, costs.map((c) => JSON.stringify(c)).join('\n') + '\n');
    await writeFile(eventsFile, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const report = computeSandboxAbReport(readEvents(eventsFile), readCosts(costsFile));

    expect(report.docker.runs).toBe(2);
    expect(report.baseline.runs).toBe(2);
    expect(report.unknownRuns).toBe(1);
    expect(report.docker.meanWallClockMs).toBe(1100);
    expect(report.baseline.meanWallClockMs).toBe(1000);
    expect(report.docker.ciPassRate).toBe(1);
    expect(report.baseline.ciPassRate).toBe(1);
    expect(['flip-default', 'keep-opt-in', 'drop', 'insufficient-data']).toContain(report.recommendation);
    expect(report.rationale.length).toBeGreaterThan(0);
  });
});
