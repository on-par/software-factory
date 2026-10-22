import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import type { CommandResult } from '../utils/command-runner.js';
import { testsChecker } from './index.js';

const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());

const THRESHOLD_LINE =
  'ERROR: Coverage for statements (96.83%) does not meet "packages/cli/src/**/*.{ts,tsx}" threshold (96.9%)';

async function runWithStderr(stderr: string) {
  const worktree = await tempDirs.make('tests-coverage-');
  await mkdir(join(worktree, 'scripts'));
  await writeFile(join(worktree, 'scripts', 'verify.sh'), '#!/bin/bash\n');
  const runCommand = async (argv: readonly string[]): Promise<CommandResult> => ({
    command: argv,
    stdout: ' Test Files  10 passed (10)\n',
    stderr,
    exitCode: 1,
    killed: false,
    timedOut: false,
    ok: false,
  });
  return testsChecker({ worktree, specPath: '', constitutionBody: '', runCommand });
}

describe('testsChecker coverage thresholds (#3536)', () => {
  it('surfaces the vitest coverage-threshold line when verify.sh fails on coverage', async () => {
    const noise = Array.from({ length: 20 }, (_, i) => `trailing stderr noise line number ${i} padding`).join('\n');
    const output = await runWithStderr(`${THRESHOLD_LINE}\n${noise}`);

    expect(output.result).toBe('FAIL');
    expect(output.details).toContain('Coverage for statements (96.83%) does not meet');
  });

  it('surfaces the threshold line when it is the last stderr line', async () => {
    const output = await runWithStderr(THRESHOLD_LINE);

    expect(output.result).toBe('FAIL');
    expect(output.details).toContain('Coverage for statements (96.83%) does not meet');
  });
});
