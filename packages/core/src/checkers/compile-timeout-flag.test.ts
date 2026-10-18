import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import type { CommandResult } from '../utils/command-runner.js';
import { compileChecker } from './index.js';

const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());

async function compile(result: Partial<CommandResult>) {
  const worktree = await tempDirs.make('compile-timeout-');
  await writeFile(join(worktree, 'package.json'), '{"scripts":{"build":"tsc"}}');
  const runCommand = vi.fn(async () => ({
    command: [],
    stdout: '',
    stderr: '',
    exitCode: 1,
    killed: false,
    timedOut: false,
    ok: false,
    ...result,
  }));
  return compileChecker({ worktree, specPath: '', constitutionBody: '', runCommand: runCommand as never });
}

describe('compileChecker timeout flag (#3186)', () => {
  it('marks a timed-out build with timedOut: true', async () => {
    const result = await compile({ exitCode: -1, killed: true, timedOut: true });
    expect(result).toMatchObject({ result: 'FAIL', timedOut: true });
    expect(result.details).toContain('timed out after');
  });

  it('does not mark a non-zero exit', async () => {
    const result = await compile({});
    expect(result.result).toBe('FAIL');
    expect(result.timedOut).toBeUndefined();
  });
});
