import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { hasOwnedProcesses, processAlive, recordOwnedProcess, waitForOwnedProcesses } from './process-ownership.js';
let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'factory-owned-'));
  file = join(dir, 'groups');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
it('persists ownership and refuses to treat a live process as released', async () => {
  expect(hasOwnedProcesses(file)).toBe(false);
  recordOwnedProcess(file, process.pid);
  expect(hasOwnedProcesses(file)).toBe(true);
  expect(await waitForOwnedProcesses(file, 0)).toBe(false);
});
it('waits for actual termination before releasing ownership', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await new Promise((resolve) => child.once('spawn', resolve));
  recordOwnedProcess(file, child.pid!);
  const released = waitForOwnedProcesses(file, 2000);
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  expect(await released).toBe(true);
  expect(processAlive(child.pid!)).toBe(false);
});
it('fails closed on invalid or unreadable ownership state', async () => {
  await writeFile(file, 'not-a-pid');
  expect(() => hasOwnedProcesses(file)).toThrow('Invalid process ownership');
  await rm(file);
  await mkdir(file);
  expect(() => hasOwnedProcesses(file)).toThrow();
});
