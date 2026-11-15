import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readWorktreeKeeps } from '../utils/worktree-keeps.js';
import { toWorkKey, workKeyFromIssue } from '../work/work-key.js';
import { budgetGuardFor, enforceIssueBudget } from './budget.js';
import { recordArgs } from '../test-support/recorders.js';
import { createTempDirs } from '../harness/temp-dir.js';

describe('enforceIssueBudget', () => {
  const tmp = createTempDirs();
  let dir: string;
  const setup = () => {
    dir = tmp.makeSync('budget-');
    return join(dir, 'keeps.json');
  };
  afterEach(() => tmp.cleanup());

  it.each([
    [10, 30],
    [30, 30],
    [99, undefined],
  ])('returns undefined for spend %s under cap %s without writing or logging', (spend, cap) => {
    const keepsFile = setup();
    const { calls, fn: log } = recordArgs((_type: string, _msg: string) => {});
    expect(
      enforceIssueBudget({ phase: 'BUILD', spend, cap, key: workKeyFromIssue(1), worktreePath: '/wt', keepsFile, log }),
    ).toBeUndefined();
    expect(existsSync(keepsFile)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('parks over the cap with the exact message and records a keep', () => {
    const keepsFile = setup();
    const { calls, fn: log } = recordArgs((_type: string, _msg: string) => {});
    const message = enforceIssueBudget({
      phase: 'BUILD',
      spend: 33.18,
      cap: 30,
      key: workKeyFromIssue(3264),
      worktreePath: '/wt/3264',
      keepsFile,
      log,
      now: () => new Date('2026-10-19T00:00:00Z'),
    });
    expect(message).toBe('per-issue budget exceeded after BUILD: $33.18 > $30.00');
    expect(calls).toEqual([['budget_exceeded', message]]);
    expect(readWorktreeKeeps(keepsFile)).toEqual([
      { issue: 3264, path: '/wt/3264', reason: 'budget_exceeded', since: '2026-10-19T00:00:00.000Z' },
    ]);
  });

  it('writes no keep when keepsFile is undefined', () => {
    setup();
    const { calls, fn: log } = recordArgs((_type: string, _msg: string) => {});
    expect(
      enforceIssueBudget({ phase: 'PLAN', spend: 5, cap: 1, key: workKeyFromIssue(1), worktreePath: '/wt', log }),
    ).toContain('after PLAN');
    expect(calls).toEqual([['budget_exceeded', expect.stringContaining('after PLAN')]]);
  });

  it('warns and still returns the message when the write fails', () => {
    const base = setup();
    writeFileSync(base, 'x');
    const { calls, fn: log } = recordArgs((_type: string, _msg: string) => {});
    const message = enforceIssueBudget({
      phase: 'BUILD',
      spend: 5,
      cap: 1,
      key: workKeyFromIssue(1),
      worktreePath: '/wt',
      keepsFile: join(base, 'nested', 'keeps.json'),
      log,
    });
    expect(message).toContain('per-issue budget exceeded after BUILD');
    expect(calls.map((c) => c[0])).toEqual(['budget_exceeded', 'warn']);
  });

  it('parks and warns for a non-numeric key without recording a keep', () => {
    const keepsFile = setup();
    const { calls, fn: log } = recordArgs((_type: string, _msg: string) => {});
    const message = enforceIssueBudget({
      phase: 'BUILD',
      spend: 5,
      cap: 1,
      key: toWorkKey('PROJ-1'),
      worktreePath: '/wt',
      keepsFile,
      log,
    });
    expect(message).toContain('per-issue budget exceeded after BUILD');
    expect(calls).toContainEqual(['warn', expect.stringContaining('could not record the kept worktree for #PROJ-1')]);
    expect(existsSync(keepsFile)).toBe(false);
  });
});

describe('enforceIssueBudget with a live stop (#3320)', () => {
  const stopTmp = createTempDirs();
  afterEach(() => stopTmp.cleanup());
  it('renders the during message, logs budget_exceeded and records a keep', () => {
    const keepsFile = join(stopTmp.makeSync('budget-stop-'), 'keeps.json');
    const { calls, fn: log } = recordArgs((_type: string, _msg: string) => {});
    const message = enforceIssueBudget({
      phase: 'BUILD',
      spend: 1.21,
      cap: 30,
      key: workKeyFromIssue(3320),
      worktreePath: '/wt',
      keepsFile,
      log,
      stop: { spendUsd: 30.21, calls: 183 },
    });
    expect(message).toBe('per-issue budget exceeded during BUILD: $30.21 > $30.00 (stopped at model call 183)');
    expect(calls).toEqual([['budget_exceeded', message]]);
    expect(readWorktreeKeeps(keepsFile).map((k) => k.path)).toEqual(['/wt']);
  });
});

describe('budgetGuardFor', () => {
  it('returns no guard without a cap', () => {
    const { guard, stopped } = budgetGuardFor({ budget: {} }, {}, { killAll: async () => [] });
    expect(guard).toBeUndefined();
    expect(stopped()).toBeUndefined();
  });

  it('stays quiet at or under the cap, then kills once over it and keeps returning true', () => {
    const { calls: kills, fn: killAll } = recordArgs(async (_o: { graceMs: number }) => []);
    const { guard, stopped } = budgetGuardFor(
      { budget: { perIssueCapUsd: 30 } },
      { getIssueSpend: () => 1.21 },
      { killAll },
      50,
    );
    expect(guard?.(28.79, 100)).toBe(false);
    expect(kills).toEqual([]);
    expect(guard?.(29, 183)).toBe(true);
    expect(kills).toEqual([[{ graceMs: 50 }]]);
    expect(guard?.(40, 190)).toBe(true);
    expect(kills).toEqual([[{ graceMs: 50 }]]);
    expect(stopped()).toEqual({ spendUsd: 30.21, calls: 183 });
  });

  it('counts only the running spend without a cost sink and logs a failing kill', async () => {
    const killAll = () => Promise.reject(new Error('gone'));
    const { calls, fn: log } = recordArgs((_type: string, _msg: string) => {});
    const { guard } = budgetGuardFor({ budget: { perIssueCapUsd: 1 } }, {}, { killAll }, undefined, log);
    expect(guard?.(2, 1)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual([['warn', 'budget kill failed: gone']]);
  });
});
