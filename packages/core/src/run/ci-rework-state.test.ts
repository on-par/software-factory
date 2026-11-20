import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { workKeyFromIssue } from '../work/work-key.js';
import { ciReworkBudget, mergeCiReworkRounds, readCiReworkBudget } from './ci-rework-state.js';
import { nextIssueRunState, runStateFile, writeIssueRunState } from './state.js';

const base = {
  issue: 42,
  lane: 'bugfix',
  branch: 'factory/42-fix',
  worktree: '/w',
  specPath: '/s.md',
  startedAt: '2026-01-01T00:00:00.000Z',
};
const key = workKeyFromIssue(42);

describe('ci rework state (#4311)', () => {
  const dirs = createTempDirs();
  afterEach(() => dirs.cleanup());

  const write = async (extra: Record<string, unknown>): Promise<{ dir: string; file: string }> => {
    const dir = await dirs.make('ci-rework-state-');
    const file = runStateFile(dir, key);
    await writeIssueRunState(file, {
      ...nextIssueRunState(undefined, base, { status: 'shipping' }, 't1'),
      ...extra,
    } as never);
    return { dir, file };
  };

  it('returns zero used and the default cap 2 when no round is recorded', async () => {
    const empty = await dirs.make('ci-rework-state-');
    expect(await readCiReworkBudget(empty, key, 7, {})).toEqual({ used: 0, cap: 2 });
    const { dir } = await write({});
    expect(await readCiReworkBudget(dir, key, 7, {})).toEqual({ used: 0, cap: 2 });
  });

  it('returns the rounds recorded for the PR and ignores other PRs', async () => {
    const { dir } = await write({ ciReworkRounds: { '7': 2, '9': 1 } });
    expect((await readCiReworkBudget(dir, key, 7, {})).used).toBe(2);
    expect((await readCiReworkBudget(dir, key, 9, {})).used).toBe(1);
    expect((await readCiReworkBudget(dir, key, 8, {})).used).toBe(0);
  });

  it('honours FACTORY_MAX_CI_REWORK_ROUNDS for the cap', async () => {
    const { dir } = await write({ ciReworkRounds: { '7': 1 } });
    expect(await readCiReworkBudget(dir, key, 7, { FACTORY_MAX_CI_REWORK_ROUNDS: '4' })).toEqual({ used: 1, cap: 4 });
  });

  it('treats a malformed ciReworkRounds value as zero', async () => {
    for (const bad of [{ '7': -1, x: 3 }, 'bad', [3]]) {
      const { dir } = await write({ ciReworkRounds: bad });
      expect((await readCiReworkBudget(dir, key, 7, {})).used).toBe(0);
    }
    expect(ciReworkBudget(null, 7, {})).toEqual({ used: 0, cap: 2 });
  });

  it('a second process reads the count the first process wrote', async () => {
    const { dir, file } = await write({ ciReworkRounds: { '7': 1 } });
    vi.resetModules();
    const fresh = await import('./ci-rework-state.js');
    expect(await fresh.readCiReworkBudget(dir, key, 7, {})).toEqual({ used: 1, cap: 2 });
    const script =
      "const fs=require('fs');process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],'utf8')).ciReworkRounds['7']))";
    expect(execFileSync(process.execPath, ['-e', script, join(file)], { encoding: 'utf8' })).toBe('1');
  });

  it('mergeCiReworkRounds keeps the max per key and is undefined when empty', () => {
    expect(mergeCiReworkRounds({ '7': 1, '9': 3 }, undefined, { '7': 2 })).toEqual({ '7': 2, '9': 3 });
    expect(mergeCiReworkRounds()).toBeUndefined();
    expect(mergeCiReworkRounds(undefined, { x: 1 })).toBeUndefined();
  });
});
