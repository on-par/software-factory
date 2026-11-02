// #3851: a CHECK environment release on a red base whose GitHub CI is green must not loop claim → build → release.

import { join } from 'node:path';

import { getFactoryPaths } from '@on-par/factory-core';
import { BaselineCache, runBaselineCheckers } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBaseHoldGate, readBaseHold, type BaseHoldCleared } from './base-hold.js';
import { LaneEnvironmentPauseError } from './lane-environment-pause-error.js';
import { runLane } from './run-lane.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const ISSUE = 5;
const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

const okResult = { command: [], stdout: '', stderr: '', exitCode: 0, killed: false, timedOut: false, ok: true };

function setup() {
  const dir = dirs.makeSync('lane-check-base-hold-');
  const paths = { ...getFactoryPaths(dir), events: join(dir, 'events.ndjson'), stop: join(dir, 'STOP') };
  const file = paths.baseHold;
  const state = { sha: SHA_A, queued: true, claims: 0, builds: {} as Record<string, number> };
  const cleared: BaseHoldCleared[] = [];
  const events: Array<{ kind: string; message: string }> = [];
  const cache = new BaselineCache(join(dir, 'baseline-cache.json'));
  const verdict = async () => ({ green: true, reason: 'push checks: verify', basis: 'push checks: verify' });
  const baseHoldGate = createBaseHoldGate({
    file,
    repo: 'o/r',
    git: async () => `${state.sha}\trefs/heads/main\n`,
    requiredChecksVerdict: verdict,
    onCleared: (c) => cleared.push(c),
  });
  const ship = async (): Promise<string> => {
    const sha = state.sha;
    state.builds[sha] = (state.builds[sha] ?? 0) + 1;
    if (sha !== SHA_A) return 'factory/5-x';
    const report = await runBaselineCheckers({
      baseSha: sha,
      laneWorktree: dir,
      failing: [{ checker: 'links', result: 'FAIL', details: 'broken link' }],
      ctx: { worktree: dir, specPath: '', env: {} },
      router: {} as never,
      constitution: null,
      cache,
      requiredChecksVerdict: verdict,
      deps: {
        runCommand: vi.fn(async () => okResult),
        makeTempDir: async () => dirs.make('lane-base-'),
        runCheckers: vi.fn(async () => ({
          failures: 1,
          passes: 0,
          skips: 0,
          total: 1,
          results: [{ checker: 'links', result: 'FAIL' as const, details: 'broken link' }],
        })) as never,
      },
    });
    throw new LaneEnvironmentPauseError('base broken', {
      baseSha: sha,
      failingChecks: ['links'],
      confirmedLocally: report.confirmedLocally,
    });
  };
  const poll = () =>
    runLane('app', [], '/repo', 'o/r', paths, {
      ship,
      waitMerge: async () => ({}) as never,
      pathExists: () => false,
      emitEvent: (_f, kind, _id, message) => {
        events.push({ kind, message: String(message) });
      },
      claimNext: async () => {
        if (!state.queued) return null;
        state.queued = false;
        state.claims++;
        return { issue: ISSUE, decision: { kind: 'build' as const } };
      },
      releaseIssue: async (_issue, outcome) => {
        state.queued = outcome === 'queued';
      },
      reapWorktree: async () => {},
      baseHoldGate,
    });
  return { state, file, cleared, events, poll };
}

describe('runLane CHECK environment release on a green-CI red base (#3851)', () => {
  it('builds once per base SHA and keeps a confirmedLocally hold across three polls with green CI (#3851)', async () => {
    const { state, file, cleared, events, poll } = setup();
    await poll();
    await poll();
    await poll();
    expect(state.builds[SHA_A]).toBe(1);
    expect(state.claims).toBe(1);
    const hold = readBaseHold(file);
    expect(hold?.confirmedLocally).toBe(true);
    expect(hold?.issue).toBe(ISSUE);
    expect(cleared.some((c) => c.reason === 'ci-green')).toBe(false);
    const kept = events.filter((e) => e.kind === 'warn' && e.message.includes('not claiming: base hold'));
    expect(kept).toHaveLength(2);
  });

  it('clears the hold with sha-changed after origin/main moves and claims the issue exactly once (#3851)', async () => {
    const { state, file, cleared, poll } = setup();
    await poll();
    await poll();
    state.sha = SHA_B;
    await poll();
    expect(cleared).toHaveLength(1);
    expect(cleared[0].reason).toBe('sha-changed');
    expect(readBaseHold(file)).toBeNull();
    expect(state.builds[SHA_B]).toBe(1);
    expect(state.claims).toBe(2);
  });
});
