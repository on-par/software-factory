import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { defaultExecFn } from './exec.js';
import { killProcessGroup } from '../environment/process-groups.js';
import { hasOwnedProcesses } from '../daemon/process-ownership.js';
let dir: string;
let pid: number | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'factory-supervised-'));
  pid = undefined;
});
afterEach(async () => {
  if (pid) await killProcessGroup(pid, { graceMs: 20 });
  await rm(dir, { recursive: true, force: true });
});
it('returns the shell output promptly while retaining group ownership for lane cleanup', async () => {
  const ownershipFile = join(dir, 'groups');
  const result = await defaultExecFn("printf 'hello'", {
    cwd: dir,
    env: { FACTORY_DAEMON_GROUPS_FILE: ownershipFile },
    onPgid: (value) => (pid = value),
    timeoutMs: 2000,
  });
  expect(result).toEqual({ stdout: 'hello', stderr: '' });
  expect(hasOwnedProcesses(ownershipFile)).toBe(true);
  await killProcessGroup(pid!, { graceMs: 20 });
  await expect.poll(() => hasOwnedProcesses(ownershipFile)).toBe(false);
});
it('preserves failed shell results and timeout cleanup', async () => {
  const ownershipFile = join(dir, 'groups');
  await expect(
    defaultExecFn('exit 7', {
      cwd: dir,
      env: { FACTORY_DAEMON_GROUPS_FILE: ownershipFile },
      onPgid: (value) => (pid = value),
      timeoutMs: 2000,
    }),
  ).rejects.toMatchObject({ code: 7 });
  await killProcessGroup(pid!, { graceMs: 20 });
  await expect(
    defaultExecFn('sleep 10', {
      cwd: dir,
      env: { FACTORY_DAEMON_GROUPS_FILE: ownershipFile },
      onPgid: (value) => (pid = value),
      timeoutMs: 100,
      killGraceMs: 20,
    }),
  ).rejects.toMatchObject({ killed: true });
});
it('does not start the shell if ownership cannot be recorded', async () => {
  const directoryFile = join(dir, 'not-a-directory');
  await writeFile(directoryFile, 'block');
  await expect(
    defaultExecFn('echo should-not-run', {
      cwd: dir,
      env: { FACTORY_DAEMON_GROUPS_FILE: join(directoryFile, 'groups') },
      onPgid: (value) => (pid = value),
      timeoutMs: 2000,
    }),
  ).rejects.toThrow();
});
