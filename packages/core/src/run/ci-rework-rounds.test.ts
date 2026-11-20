import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import type { ShipResult } from '../phases/ship.js';
import type { IssueRunState } from '../types/index.js';
import type { CiReworkLoopContext } from './ci-rework-loop.js';
import { runCiReworkRound, type CiReworkRoundPorts } from './ci-rework-round.js';
import {
  CHECK_OK,
  checkPhase,
  ports,
  readReworkDiff,
  readWorktreeHead,
  request,
  resetCiReworkMocks,
  reworkWorker,
  shipPhase,
} from './ci-rework-test-helpers.js';
import { ciReworkRoundsFor, recordCiReworkRound, type CiReworkRoundsUsage } from './ci-rework-rounds.js';
import { renderPreviousAttempt } from './previous-attempt.js';
import {
  nextIssueRunState,
  readIssueRunState,
  writeIssueRunState,
  type IssueRunStateBase,
  type RunStateUpdate,
} from './state.js';

const dirs = createTempDirs();
afterAll(() => dirs.cleanup());

const BASE: IssueRunStateBase = {
  issue: 7,
  lane: 'lane-a',
  branch: 'issue-7-thing',
  worktree: '/tmp/wt-7',
  specPath: '/tmp/wt-7/spec.md',
  startedAt: '2026-11-20T00:00:00.000Z',
};

async function fileRecorder(): Promise<{ file: string; record: (update: RunStateUpdate) => Promise<void> }> {
  const file = join(await dirs.make('ci-rework-rounds-'), 'issue-7.json');
  let current: IssueRunState | undefined;
  const record = async (update: RunStateUpdate): Promise<void> => {
    current = nextIssueRunState(current, BASE, update, '2026-11-20T00:01:00.000Z');
    await writeIssueRunState(file, { ...current, repo: 'o/r' });
  };
  return { file, record };
}

const roundPorts = (record: (update: RunStateUpdate) => Promise<void>) => ({
  recordRunState: record,
  events: () => () => {},
});

const usageFromFile = async (file: string, prNumber: number): Promise<CiReworkRoundsUsage> =>
  ciReworkRoundsFor(await readIssueRunState(file), prNumber, {});

describe('CI rework rounds in run state', () => {
  it('writes each round count per PR into the run state file', async () => {
    const { file, record } = await fileRecorder();
    const ports = roundPorts(record);
    await recordCiReworkRound(ports, { round: 1, reentry: { prNumber: 9 } });
    await recordCiReworkRound(ports, { round: 2, reentry: { prNumber: 9 } });
    await recordCiReworkRound(ports, { round: 1, reentry: { prNumber: 12 } });
    await record({ status: 'parked' });
    const persisted = JSON.parse(await readFile(file, 'utf-8')) as IssueRunState;
    expect(persisted.ciReworkRounds).toEqual({ '9': 2, '12': 1 });
    expect(persisted.status).toBe('parked');
  });

  it('reads rounds used and the default cap for a PR', async () => {
    const { file, record } = await fileRecorder();
    await recordCiReworkRound(roundPorts(record), { round: 1, reentry: { prNumber: 9 } });
    expect(await usageFromFile(file, 9)).toEqual({ used: 1, cap: 2 });
    expect(await usageFromFile(file, 10)).toEqual({ used: 0, cap: 2 });
    expect(await usageFromFile(join(file, '..', 'missing.json'), 9)).toEqual({ used: 0, cap: 2 });
    const state = await readIssueRunState(file);
    expect(ciReworkRoundsFor(state, 9, { FACTORY_MAX_CI_REWORK_ROUNDS: '4' })).toEqual({ used: 1, cap: 4 });
  });

  it('ignores a malformed persisted count', () => {
    const state = { ciReworkRounds: { '9': -1, '10': 1.5 } };
    expect(ciReworkRoundsFor(state, 9, {})).toEqual({ used: 0, cap: 2 });
    expect(ciReworkRoundsFor(state, 10, {})).toEqual({ used: 0, cap: 2 });
  });

  it('a fresh module instance with no shared memory reads the same count', async () => {
    const { file, record } = await fileRecorder();
    await recordCiReworkRound(roundPorts(record), { round: 2, reentry: { prNumber: 9 } });
    vi.resetModules();
    const freshState = await import('./state.js');
    const freshRounds = await import('./ci-rework-rounds.js');
    expect(freshRounds.ciReworkRoundsFor).not.toBe(ciReworkRoundsFor);
    const reread = await freshState.readIssueRunState(file);
    expect(freshRounds.ciReworkRoundsFor(reread, 9, {})).toEqual({ used: 2, cap: 2 });
  });

  it('shows the persisted count in the previous-attempt note of a later run', async () => {
    vi.stubEnv('FACTORY_MAX_CI_REWORK_ROUNDS', '');
    const { file, record } = await fileRecorder();
    await record({ status: 'shipping', prNumber: 9 });
    await recordCiReworkRound(roundPorts(record), { round: 2, reentry: { prNumber: 9 } });
    await record({ status: 'parked' });
    expect(renderPreviousAttempt(await readIssueRunState(file))).toContain('CI rework rounds on PR #9: 2/2)');
    await record({ status: 'parked', prNumber: 10 });
    expect(renderPreviousAttempt(await readIssueRunState(file))).not.toContain('CI rework rounds');
    vi.unstubAllEnvs();
  });

  it('persists the round count before the round re-ships its push', async () => {
    const { file, record } = await fileRecorder();
    let seenAtPush: CiReworkRoundsUsage | undefined;
    const shipped = { ok: true, prNumber: 9 } as ShipResult;
    resetCiReworkMocks();
    const ctx: CiReworkLoopContext = {
      request,
      ports: { ...ports(() => {}), recordRunState: record },
      shipPhase,
      checkPhase,
      checkOpts: {} as CiReworkLoopContext['checkOpts'],
      check: CHECK_OK,
      constitution: null,
      appPort: undefined,
      appBaseUrl: undefined,
      onPgid: () => {},
      runId: 'run-1',
      onRecheck: async () => undefined,
    };
    const roundDeps: CiReworkRoundPorts = {
      ctx,
      rework: reworkWorker,
      readHead: readWorktreeHead,
      readDiff: readReworkDiff,
      builtRoute: 'claude',
      builtModel: 'm',
      reship: async () => {
        seenAtPush = await usageFromFile(file, 9);
        return shipped;
      },
    };
    const step = await runCiReworkRound(roundDeps, {
      round: 1,
      reentry: { prNumber: 9, previousHeadSha: 'abc1234' },
      summary: { failures: 1, passes: 0, skips: 0, total: 1, results: [] },
      extraInstructions: '',
    });
    expect(step).toEqual({ kind: 'shipped', ship: shipped });
    expect(seenAtPush).toEqual({ used: 1, cap: 2 });
  });
});
