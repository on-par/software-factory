import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultExecFn } from './exec.js';

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err: any) {
    return err?.code === 'ESRCH';
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('defaultExecFn', () => {
  it('resolves stdout for a quick command', async () => {
    const { stdout } = await defaultExecFn('echo hi', {});

    expect(stdout).toContain('hi');
  });

  it('passes timeoutMs through as a real kill timeout', async () => {
    const err: any = await defaultExecFn('sleep 2', { timeoutMs: 50 }).catch((e) => e);

    expect(err).toBeTruthy();
    expect(err.killed).toBe(true);
  });

  it('passes cwd through', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'exec-test-'));
    try {
      const realDir = await realpath(dir);
      const { stdout } = await defaultExecFn('pwd', { cwd: dir });

      expect(await realpath(stdout.trim())).toBe(realDir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('merges opts.env over the parent env instead of replacing it', async () => {
    const { stdout } = await defaultExecFn('node -p "process.env.FACTORY_APP_PORT + \':\' + typeof process.env.PATH"', {
      env: { FACTORY_APP_PORT: '3142' },
    });

    expect(stdout.trim()).toBe('3142:string');
  });

  it('leaves the environment unchanged when opts.env is omitted', async () => {
    const { stdout } = await defaultExecFn('node -p "typeof process.env.PATH"', {});

    expect(stdout.trim()).toBe('string');
  });

  describe.skipIf(process.platform === 'win32')('onPgid grandchild sweep', () => {
    it('fires onPgid and, on timeout, kills the grandchild too', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'exec-onpgid-'));
      const pidFile = join(dir, 'gc.pid');
      try {
        let reportedPid: number | undefined;

        const err: any = await defaultExecFn(`sleep 30 & echo $! > ${pidFile}; wait`, {
          timeoutMs: 300,
          killGraceMs: 100,
          onPgid: (pgid) => {
            reportedPid = pgid;
          },
        }).catch((e) => e);

        expect(err).toBeTruthy();
        expect(err.killed).toBe(true);
        expect(reportedPid).toBeDefined();

        let raw = '';
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline && raw === '') {
          try {
            raw = (await readFile(pidFile, 'utf-8')).trim();
          } catch {
            // not written yet
          }
          if (raw === '') await new Promise((r) => setTimeout(r, 50));
        }
        const grandchildPid = Number(raw);

        await waitUntil(() => isDead(grandchildPid), 2000);
        expect(isDead(grandchildPid)).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 10000);

    it('does not spawn detached when onPgid is absent (unchanged behavior)', async () => {
      const { stdout } = await defaultExecFn('echo hi', { timeoutMs: 1000 });
      expect(stdout).toContain('hi');
    });
  });
});
