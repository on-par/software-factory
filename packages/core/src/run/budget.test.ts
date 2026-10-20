import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readWorktreeKeeps } from '../utils/worktree-keeps.js';
import { enforceIssueBudget } from './budget.js';
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
    const log = vi.fn();
    expect(
      enforceIssueBudget({ phase: 'BUILD', spend, cap, issue: 1, worktreePath: '/wt', keepsFile, log }),
    ).toBeUndefined();
    expect(existsSync(keepsFile)).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it('parks over the cap with the exact message and records a keep', () => {
    const keepsFile = setup();
    const log = vi.fn();
    const message = enforceIssueBudget({
      phase: 'BUILD',
      spend: 33.18,
      cap: 30,
      issue: 3264,
      worktreePath: '/wt/3264',
      keepsFile,
      log,
      now: () => new Date('2026-10-19T00:00:00Z'),
    });
    expect(message).toBe('per-issue budget exceeded after BUILD: $33.18 > $30.00');
    expect(log).toHaveBeenCalledWith('budget_exceeded', message);
    expect(readWorktreeKeeps(keepsFile)).toEqual([
      { issue: 3264, path: '/wt/3264', reason: 'budget_exceeded', since: '2026-10-19T00:00:00.000Z' },
    ]);
  });

  it('writes no keep when keepsFile is undefined', () => {
    setup();
    const log = vi.fn();
    expect(enforceIssueBudget({ phase: 'PLAN', spend: 5, cap: 1, issue: 1, worktreePath: '/wt', log })).toContain(
      'after PLAN',
    );
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('warns and still returns the message when the write fails', () => {
    const base = setup();
    writeFileSync(base, 'x');
    const log = vi.fn();
    const message = enforceIssueBudget({
      phase: 'BUILD',
      spend: 5,
      cap: 1,
      issue: 1,
      worktreePath: '/wt',
      keepsFile: join(base, 'nested', 'keeps.json'),
      log,
    });
    expect(message).toContain('per-issue budget exceeded after BUILD');
    expect(log.mock.calls.map((c) => c[0])).toEqual(['budget_exceeded', 'warn']);
  });
});
