import { execSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from './cli/index.js';

const tmp = createTempDirs();
let repo: string;
let cwd: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  cwd = process.cwd();
  repo = realpathSync(tmp.makeSync('cli-steerability-'));
  execSync('git init -q', { cwd: repo });
  mkdirSync(join(repo, '.factory', 'state', 'runs'), { recursive: true });
  process.chdir(repo);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(async () => {
  process.chdir(cwd);
  await tmp.cleanup();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const logged = () => logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
const errored = () => errSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
const runMain = (...args: string[]) => main(['node', 'factory', ...args]);

function seedRun(issue: number, lane: string, steerTs: string[]) {
  writeFileSync(
    join(repo, '.factory', 'state', 'runs', `issue-${issue}.json`),
    JSON.stringify({
      issue,
      lane,
      repo: 'o/r',
      updatedAt: '2026-08-01T00:00:00.000Z',
      steers: steerTs.map((ts) => ({ ts, actor: 'a', source: 'cli', phase: 'build', summary: 's' })),
    }),
  );
}

function seedOutcomes(merges: Array<[number, string]>) {
  writeFileSync(
    join(repo, '.factory', 'state', 'classifier-outcomes.jsonl'),
    merges.map(([n, mergedAt]) => JSON.stringify({ issue: String(n), prNumber: n, merged: true, mergedAt })).join('\n'),
  );
}

describe('report --steerability (#3403)', () => {
  it('--json with no runs or outcomes prints an empty report and exits 0', async () => {
    await runMain('report', '--steerability', '--json');
    expect(process.exitCode).toBeUndefined();
    const report = JSON.parse(logged().trim());
    expect(report.total.mergedPrs).toBe(0);
    expect(report.total.steersPerMergedPr).toBeNull();
    expect(report.total.distribution).toBeNull();
    expect(report.byLane).toEqual([]);
    expect(report.byWeek).toEqual([]);
  });

  it('--json reports per-lane and per-week buckets', async () => {
    seedRun(1, 'small', ['2026-08-03T00:00:00.000Z', '2026-08-03T01:00:00.000Z']);
    seedRun(2, 'large', []);
    seedOutcomes([
      [1, '2026-08-04T00:00:00.000Z'],
      [2, '2026-08-12T00:00:00.000Z'],
    ]);
    await runMain('report', '--steerability', '--json');
    const report = JSON.parse(logged().trim());
    expect(report.byLane.map((b: { key: string }) => b.key)).toEqual(['large', 'small']);
    expect(report.byLane[1].steersPerMergedPr).toBe(2);
    expect(report.byWeek.map((b: { key: string }) => b.key)).toEqual(['2026-W32', '2026-W33']);
    expect(report.total.distribution.histogram).toEqual({ '0': 1, '1': 0, '2': 1 });
  });

  it('prints text', async () => {
    await runMain('report', '--steerability');
    expect(logged()).toContain('No merged PRs with run state yet.');
  });

  it('without --steerability exits 2', async () => {
    await runMain('report');
    expect(process.exitCode).toBe(2);
    expect(errored()).toContain('factory: report requires --steerability');
  });

  it('classifier report includes the steerability section and --json carries steerability', async () => {
    await runMain('classifier', 'report');
    expect(logged()).toContain('Steerability (steers per merged PR):');
    logSpy.mockClear();
    await runMain('classifier', 'report', '--json');
    expect(JSON.parse(logged().trim()).steerability.schemaVersion).toBe(1);
  });
});
