import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { VERIFY_ENV_MARKER } from '../environment/sandbox-env.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { testsChecker } from './index.js';

const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());

async function checkWith(exitCode: number, stdout: string, files: Record<string, string>) {
  const worktree = await tempDirs.make('tests-sandbox-env-');
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(worktree, path, '..'), { recursive: true });
    await writeFile(join(worktree, path), body);
  }
  return testsChecker({
    worktree,
    specPath: join(worktree, 'none.md'),
    constitutionBody: '',
    runCommand: async (argv) => ({
      command: argv,
      stdout,
      stderr: '',
      exitCode,
      killed: false,
      timedOut: false,
      ok: false,
    }),
  });
}

const VERIFY = { 'scripts/verify.sh': '#!/bin/bash\n' };

describe('testsChecker sandbox environment marker (#3332)', () => {
  it('tags a verify.sh exit 78 with the marker', async () => {
    const r = await checkWith(78, `${VERIFY_ENV_MARKER}\nverify: EPERM: tcp 127.0.0.1: listen EPERM\n`, VERIFY);
    expect(r.result).toBe('FAIL');
    expect(r.sandboxEnv).toContain(VERIFY_ENV_MARKER);
  });

  it('leaves exit 78 without the marker, and exit 1 with the marker, as plain FAILs', async () => {
    expect((await checkWith(78, 'boom', VERIFY)).sandboxEnv).toBeUndefined();
    const r = await checkWith(1, VERIFY_ENV_MARKER, VERIFY);
    expect(r.result).toBe('FAIL');
    expect(r.sandboxEnv).toBeUndefined();
  });

  it('does not tag the npm runner', async () => {
    const r = await checkWith(78, VERIFY_ENV_MARKER, { 'package.json': JSON.stringify({ scripts: { test: 'x' } }) });
    expect(r.result).toBe('FAIL');
    expect(r.sandboxEnv).toBeUndefined();
  });
});
