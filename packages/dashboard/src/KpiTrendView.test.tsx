// @vitest-environment jsdom
import type { KpiHistoryRecord } from '@on-par/factory-core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { KpiTrendView } from './KpiTrendView.js';

afterEach(cleanup);

// Mirrors the rolling-window size baked into kpiTrend.ts's local port of computeKpiDrift —
// enough history for the drift-flag series to be ready.
const KPI_DRIFT_WINDOW_SIZE = 20;

/** A fixture with the fields #612 (postMergeDefectRate), #613 (enough history for
 *  the rolling drift window to be ready), and #614 (phaseDurationsMs/phaseCosts) populated. */
function fixtureJsonl(): string {
  const records: KpiHistoryRecord[] = Array.from({ length: KPI_DRIFT_WINDOW_SIZE * 2 }, (_, i) => ({
    date: `run-${i}`,
    runs: 10,
    mergeRate: 0.9,
    reworkRate: 0.2,
    collisionReworkRate: 0.05,
    stuckRate: 0.01,
    humanInterventionRate: 0.1,
    fullyAutonomousRate: 0.8,
    costPerMergedPr: 5,
    medianCycleTimeMs: 600_000,
    p90CycleTimeMs: 900_000,
    postMergeDefectRate: 0.1,
    defectWindowClosedRuns: 8,
    phaseDurationsMs: { plan: 1000, build: 5000, check: 2000, ship: 500 },
    phaseCosts: { plan: 0.01, build: 0.05, check: 0.02, ship: 0.005 },
  }));
  return records.map((record) => JSON.stringify(record)).join('\n');
}

function expectNonEmptySparkline(label: string) {
  const chart = screen.getByRole('img', { name: label });
  expect(chart.children.length).toBeGreaterThan(0);
}

describe('KpiTrendView', () => {
  it('shows an empty state with no KPI history', () => {
    render(<KpiTrendView kpiHistoryJsonl="" />);
    expect(screen.getByText('No KPI history yet.')).toBeDefined();
  });

  it('renders a non-empty trend chart for post-merge defect rate', () => {
    render(<KpiTrendView kpiHistoryJsonl={fixtureJsonl()} />);
    expectNonEmptySparkline('Post-merge defect rate');
  });

  it('renders a non-empty trend chart for drift flags', () => {
    render(<KpiTrendView kpiHistoryJsonl={fixtureJsonl()} />);
    expectNonEmptySparkline('Drift flags');
  });

  it('renders a non-empty trend chart for phase-level cost/time breakdown', () => {
    render(<KpiTrendView kpiHistoryJsonl={fixtureJsonl()} />);
    expect(screen.getByText('Phase-level cost/time breakdown')).toBeDefined();
    expectNonEmptySparkline('plan duration');
    expectNonEmptySparkline('plan cost');
    expectNonEmptySparkline('build duration');
    expectNonEmptySparkline('build cost');
  });

  it('renders a non-empty trend chart for collision-vs-checker rework split', () => {
    render(<KpiTrendView kpiHistoryJsonl={fixtureJsonl()} />);
    expect(screen.getByText('Collision-vs-checker rework split')).toBeDefined();
    expectNonEmptySparkline('Collision-caused rework');
    expectNonEmptySparkline('Checker-caused rework');
  });

  it('labels an actual drift point as "drift" rather than "stable"', () => {
    const stable: KpiHistoryRecord[] = Array.from({ length: KPI_DRIFT_WINDOW_SIZE }, (_, i) => ({
      date: `stable-${i}`,
      runs: 10,
      mergeRate: 0.9,
      reworkRate: 0.1,
      stuckRate: 0.01,
      humanInterventionRate: 0.1,
      fullyAutonomousRate: 0.8,
      costPerMergedPr: 5,
      medianCycleTimeMs: 600_000,
      p90CycleTimeMs: 900_000,
    }));
    const worse: KpiHistoryRecord[] = Array.from({ length: KPI_DRIFT_WINDOW_SIZE }, (_, i) => ({
      date: `worse-${i}`,
      runs: 10,
      mergeRate: 0.9,
      reworkRate: 0.9,
      stuckRate: 0.01,
      humanInterventionRate: 0.1,
      fullyAutonomousRate: 0.8,
      costPerMergedPr: 5,
      medianCycleTimeMs: 600_000,
      p90CycleTimeMs: 900_000,
    }));
    const jsonl = [...stable, ...worse].map((record) => JSON.stringify(record)).join('\n');
    render(<KpiTrendView kpiHistoryJsonl={jsonl} />);

    const chart = screen.getByRole('img', { name: 'Drift flags' });
    const lastBar = chart.children[chart.children.length - 1];
    expect(lastBar.getAttribute('title')).toContain('drift');
  });

  it('falls back to a no-data message for a metric with no populated values', () => {
    const legacyRecord: KpiHistoryRecord = {
      date: 'legacy-1',
      runs: 5,
      mergeRate: 1,
      reworkRate: 0,
      stuckRate: 0,
      humanInterventionRate: 0,
      fullyAutonomousRate: 1,
      costPerMergedPr: null,
      medianCycleTimeMs: null,
      p90CycleTimeMs: null,
    };
    render(<KpiTrendView kpiHistoryJsonl={JSON.stringify(legacyRecord)} />);
    expect(screen.getAllByText('No data').length).toBeGreaterThan(0);
  });
});
