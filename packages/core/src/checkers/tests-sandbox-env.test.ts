import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { VERIFY_SANDBOX_ENV_MARKER } from '../environment/sandbox-env.js';
import { createTempDirs } from '../harness/temp-dir.js';
import type { CommandResult } from '../utils/command-runner.js';
import { testsChecker } from './index.js';

const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());

async function verifyWorktree(): Promise<string> {
  const dir = await tempDirs.make('checker-test-');
  await mkdir(join(dir, 'scripts'));
  await writeFile(join(dir, 'scripts', 'verify.sh'), '#!/usr/bin/env bash\n');
  return dir;
}

function runner(result: Partial<CommandResult>) {
  return async (argv: readonly string[]): Promise<CommandResult> => ({
    command: argv,
    stdout: '',
    stderr: '',
    exitCode: 1,
    killed: false,
    timedOut: false,
    ok: false,
    ...result,
  });
}

function ctx(worktree: string, result: Partial<CommandResult>) {
  return {
    worktree,
    specPath: join(worktree, 'no-such-spec.md'),
    constitutionBody: 'test constitution',
    runCommand: runner(result),
  };
}

describe('testsChecker sandbox marker (#3332)', () => {
  it('tags a FAIL that exited 78 with the verify.sh marker', async () => {
    const result = await testsChecker(
      ctx(await verifyWorktree(), { exitCode: 78, stdout: `${VERIFY_SANDBOX_ENV_MARKER}\n` }),
    );

    expect(result.result).toBe('FAIL');
    expect(result.sandboxEnv).toBe(VERIFY_SANDBOX_ENV_MARKER);
  });

  it('leaves a plain exit 1 failure untagged', async () => {
    const result = await testsChecker(ctx(await verifyWorktree(), { exitCode: 1, stdout: 'listen EPERM' }));

    expect(result.result).toBe('FAIL');
    expect(result.sandboxEnv).toBeUndefined();
  });
});
