// packages/scbench-adapter/src/manifest-fixture.ts — shared BenchmarkManifest test fixture.
import type { BenchmarkManifest } from '@on-par/factory-core';

/** Minimal, valid BenchmarkManifest for tests that only care about the
 *  fields collectArtifacts/runCheckpoint actually inspect. */
export function minimalManifest(overrides: Partial<BenchmarkManifest> = {}): BenchmarkManifest {
  return {
    manifestVersion: 1,
    run: {
      issue: 9_000_001,
      profile: 'local-only',
      outcome: 'ready',
      startedAt: '2026-07-28T00:00:00.000Z',
      endedAt: '2026-07-28T00:01:00.000Z',
      elapsedMs: 60_000,
      workspace: '/tmp/ws',
    },
    phases: { plan: 'ok', build: 'ok', check: 'ok', ship: 'skipped' },
    modelAttempts: [],
    cost: { totalUsd: 0, inputTokens: 0, outputTokens: 0, entries: [] },
    git: { changedFiles: [], diffStat: '', diffBase: 'HEAD' },
    artifacts: { manifest: 'manifest.json', request: 'request.json', events: 'events.ndjson', diff: 'diff.patch' },
    ...overrides,
  };
}
