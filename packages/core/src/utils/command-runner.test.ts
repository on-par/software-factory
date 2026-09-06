import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { describeCommandFailure, runCommand } from './command-runner.js';
import { hasOwnedProcesses } from '../daemon/process-ownership.js';
import { killProcessGroup } from '../environment/process-groups.js';

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'command-runner-test-'));
  tempDirs.add(dir);
  return dir;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('runCommand', () => {
  it('resolves with ok: true on success', async () => {
    const result = await runCommand([process.execPath, '-e', 'console.log("hi")']);

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hi');
    expect(result.killed).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.command).toEqual([process.execPath, '-e', 'console.log("hi")']);
  });

  it('resolves (does not throw) on a non-zero exit code', async () => {
    const result = await runCommand([process.execPath, '-e', 'console.error("boom"); process.exit(3)']);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('boom');
  });

  it('never interpolates argv through a shell', async () => {
    const dir = await makeTmpDir();
    const payload = `$(touch ${join(dir, 'pwned')}); echo hacked > ${join(dir, 'pwned2')}`;

    const result = await runCommand([process.execPath, '-e', 'console.log(process.argv[1])', payload]);

    expect(result.stdout.trim()).toBe(payload);
    expect(await pathExists(join(dir, 'pwned'))).toBe(false);
    expect(await pathExists(join(dir, 'pwned2'))).toBe(false);
  });

  it('round-trips untrusted-path-style args byte-identically', async () => {
    const payload = `weird 'path' with spaces and \`backticks\``;

    const result = await runCommand([process.execPath, '-e', 'console.log(process.argv[1])', payload]);

    expect(result.stdout.trim()).toBe(payload);
  });

  it('kills and reports timedOut when timeoutMs elapses', async () => {
    const result = await runCommand([process.execPath, '-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 200 });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.killed).toBe(true);
  }, 10000);

  it('honors cwd', async () => {
    const dir = await makeTmpDir();
    const realDir = await realpath(dir);

    const result = await runCommand([process.execPath, '-e', 'console.log(process.cwd())'], {
      cwd: dir,
    });

    const realStdout = await realpath(result.stdout.trim());
    expect(realStdout).toBe(realDir);
  });

  it('resolves (does not reject) when the binary does not exist', async () => {
    const result = await runCommand(['definitely-not-a-real-cmd-225']);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).not.toBe('');
  });

  it('throws a TypeError on empty argv', async () => {
    await expect(runCommand([])).rejects.toThrow(TypeError);
  });

  it('throws a TypeError on a blank argv[0]', async () => {
    await expect(runCommand(['   '])).rejects.toThrow(TypeError);
  });

  describe.skipIf(process.platform === 'win32')('onPgid (detached group tracking)', () => {
    it('does not run a checker if durable process ownership cannot be written', async () => {
      const dir = await makeTmpDir();
      const blocker = join(dir, 'blocker');
      const marker = join(dir, 'executed');
      await writeFile(blocker, 'not a directory');
      let pid: number | undefined;
      try {
        const result = await runCommand(
          [process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], "bad")', marker],
          {
            env: { FACTORY_DAEMON_GROUPS_FILE: join(blocker, 'groups') },
            onPgid: (value) => {
              pid = value;
            },
            timeoutMs: 2000,
          },
        );
        expect(result.ok).toBe(false);
        expect(result.exitCode).toBe(-1);
        expect(await pathExists(marker)).toBe(false);
      } finally {
        if (pid) await killProcessGroup(pid, { graceMs: 20 });
      }
    });

    it('preserves failed and timed-out checker results under daemon supervision', async () => {
      const dir = await makeTmpDir();
      const ownershipFile = join(dir, 'groups');
      let pid: number | undefined;
      const options = {
        env: { FACTORY_DAEMON_GROUPS_FILE: ownershipFile },
        onPgid: (value: number) => {
          pid = value;
        },
        killGraceMs: 20,
      };
      try {
        const failed = await runCommand([process.execPath, '-e', 'console.error("check failed"); process.exit(7)'], {
          ...options,
          timeoutMs: 2000,
        });
        expect(failed).toMatchObject({ exitCode: 7, killed: false, timedOut: false, ok: false });
        expect(failed.stderr).toContain('check failed');
        await killProcessGroup(pid!, { graceMs: 20 });
        const timedOut = await runCommand([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
          ...options,
          timeoutMs: 100,
        });
        expect(timedOut).toMatchObject({ killed: true, timedOut: true, ok: false });
        expect(hasOwnedProcesses(ownershipFile)).toBe(false);
      } finally {
        if (pid) await killProcessGroup(pid, { graceMs: 20 });
      }
    });

    it('retains the minus-one spawn-failure result for a missing supervised checker binary', async () => {
      const dir = await makeTmpDir();
      let pid: number | undefined;
      try {
        const result = await runCommand(['nonexistent-supervised-checker-command'], {
          env: { FACTORY_DAEMON_GROUPS_FILE: join(dir, 'groups') },
          onPgid: (value) => {
            pid = value;
          },
          timeoutMs: 2000,
        });
        expect(result).toMatchObject({ exitCode: -1, killed: false, timedOut: false, ok: false });
        expect(result.stderr).not.toBe('');
      } finally {
        if (pid) await killProcessGroup(pid, { graceMs: 20 });
      }
    });

    it('durably supervises checker argv without shell interpolation and retains ownership until cleanup', async () => {
      const dir = await makeTmpDir();
      const ownershipFile = join(dir, 'groups');
      const payload = `$(touch ${join(dir, 'pwned')}); quoted 'value'`;
      let pid: number | undefined;
      try {
        const result = await runCommand([process.execPath, '-e', 'console.log(process.argv[1])', payload], {
          env: { FACTORY_DAEMON_GROUPS_FILE: ownershipFile },
          onPgid: (value) => {
            pid = value;
          },
          timeoutMs: 2000,
        });
        expect(result.ok).toBe(true);
        expect(result.stdout.trim()).toBe(payload);
        expect(await pathExists(join(dir, 'pwned'))).toBe(false);
        expect(hasOwnedProcesses(ownershipFile)).toBe(true);
      } finally {
        if (pid) await killProcessGroup(pid, { graceMs: 20 });
      }
    });

    function isDead(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return false;
      } catch (err: any) {
        return err?.code === 'ESRCH';
      }
    }

    it('fires onPgid and, on timeout, sweeps a backgrounded grandchild', async () => {
      const dir = await makeTmpDir();
      const pidFile = join(dir, 'gc.pid');
      let reportedPid: number | undefined;

      const result = await runCommand(['sh', '-c', `sleep 30 & echo $! > ${pidFile}; wait`], {
        timeoutMs: 300,
        killGraceMs: 100,
        onPgid: (pgid) => {
          reportedPid = pgid;
        },
      });

      expect(result.timedOut).toBe(true);
      expect(result.killed).toBe(true);
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

      const aliveDeadline = Date.now() + 2000;
      while (Date.now() < aliveDeadline && !isDead(grandchildPid)) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(isDead(grandchildPid)).toBe(true);
    }, 10000);

    it('does not spawn detached when onPgid is absent (existing tests untouched)', async () => {
      const result = await runCommand([process.execPath, '-e', 'console.log("hi")']);
      expect(result.stdout).toContain('hi');
    });
  });
});

describe('describeCommandFailure', () => {
  it('prefers stderr', () => {
    const details = describeCommandFailure({
      command: ['x'],
      stdout: 'out',
      stderr: 'err',
      exitCode: 1,
      killed: false,
      timedOut: false,
      ok: false,
    });

    expect(details).toBe('err');
  });

  it('falls back to stdout when stderr is empty', () => {
    const details = describeCommandFailure({
      command: ['x'],
      stdout: 'out',
      stderr: '',
      exitCode: 1,
      killed: false,
      timedOut: false,
      ok: false,
    });

    expect(details).toBe('out');
  });

  it('falls back to a timed out note when both are empty and timedOut', () => {
    const details = describeCommandFailure({
      command: ['x'],
      stdout: '',
      stderr: '',
      exitCode: -1,
      killed: true,
      timedOut: true,
      ok: false,
    });

    expect(details).toBe('timed out');
  });

  it('falls back to an exit code note when both are empty and not timed out', () => {
    const details = describeCommandFailure({
      command: ['x'],
      stdout: '',
      stderr: '',
      exitCode: 7,
      killed: false,
      timedOut: false,
      ok: false,
    });

    expect(details).toBe('exit code 7');
  });
});
