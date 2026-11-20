import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { workKeyFromIssue } from '../work/work-key.js';
import { mergeCiReworkRounds } from './ci-rework-state.js';
import { nextIssueRunState, readIssueRunState, runStateFile, writeIssueRunState } from './state.js';

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

  it('persists the rounds recorded per PR', async () => {
    const { file } = await write({ ciReworkRounds: { '7': 2, '9': 1 } });
    expect((await readIssueRunState(file))?.ciReworkRounds).toEqual({ '7': 2, '9': 1 });
  });

  it('records no rounds when none were written', async () => {
    const { file } = await write({});
    expect((await readIssueRunState(file))?.ciReworkRounds).toBeUndefined();
  });

  it('a second process reads the count the first process wrote', async () => {
    const { file } = await write({ ciReworkRounds: { '7': 1 } });
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
