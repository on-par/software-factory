import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildSteerabilityReport, readRunStates } from './steerability-report.js';

const tmp = createTempDirs();
let dir: string;

beforeEach(() => {
  dir = tmp.makeSync('steerability-');
  mkdirSync(join(dir, 'runs'));
});
afterEach(() => tmp.cleanup());

function seed() {
  const steer = { ts: '2026-08-03T00:00:00.000Z', actor: 'a', source: 'cli', phase: 'build', summary: 's' };
  writeFileSync(join(dir, 'runs', 'issue-1.json'), JSON.stringify({ issue: 1, lane: 'small', steers: [steer] }));
  writeFileSync(join(dir, 'runs', 'issue-1.phase.json'), JSON.stringify({ issue: 1 }));
  writeFileSync(join(dir, 'runs', 'issue-2.json'), '{not json');
  const outcomes = join(dir, 'outcomes.jsonl');
  writeFileSync(
    outcomes,
    `${JSON.stringify({ issue: '1', prNumber: 5, merged: true, mergedAt: '2026-08-04T00:00:00.000Z' })}\n`,
  );
  return outcomes;
}

describe('readRunStates', () => {
  it('skips phase snapshots and malformed files', async () => {
    seed();
    const states = await readRunStates(join(dir, 'runs'));
    expect(states.map((s) => s.issue)).toEqual([1]);
  });

  it('returns [] for a missing dir', async () => {
    expect(await readRunStates(join(dir, 'nope'))).toEqual([]);
  });
});

describe('buildSteerabilityReport', () => {
  it('builds the report end to end', async () => {
    const classifierOutcomes = seed();
    const report = await buildSteerabilityReport({ runs: join(dir, 'runs'), classifierOutcomes });
    expect(report.total).toMatchObject({ mergedPrs: 1, steers: 1, steersPerMergedPr: 1 });
    expect(report.byLane[0].key).toBe('small');
  });

  it('tolerates missing files', async () => {
    const report = await buildSteerabilityReport({ runs: join(dir, 'x'), classifierOutcomes: join(dir, 'y') });
    expect(report.total.mergedPrs).toBe(0);
  });
});
