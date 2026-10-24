import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { VERIFY_SANDBOX_ENV_MARKER } from '../environment/sandbox-env.js';
import type { CommandResult } from '../utils/command-runner.js';
import { testsChecker } from './index.js';

const tempDirs = new Set<string>();
afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

async function verifyWorktree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'checker-test-'));
  tempDirs.add(dir);
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
