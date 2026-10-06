import { existsSync, statSync } from 'node:fs';
import {
  mkdir as mkdirFs,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile as writeFileFs,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultExecFn } from '../utils/exec.js';
import type { GitExecFn, WorktreeSnapshot } from './worktree-state.js';
import { captureWorktreeState, resetWorktreeState } from './worktree-state.js';

let symlinksSupported = true;
try {
  const probeDir = await mkdtemp(join(tmpdir(), 'wt-symlink-probe-'));
  const probeLink = join(probeDir, '..', `probe-link-${Date.now()}`);
  await symlink(probeDir, probeLink);
  await rm(probeLink, { force: true }).catch(() => {});
  await rm(probeDir, { recursive: true, force: true });
} catch {
  symlinksSupported = false;
}

type Handler = (
  cmd: string,
  opts: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }> | { stdout: string; stderr: string };

function makeFakeExec(handlers: Array<[RegExp, Handler]>): { execFn: GitExecFn; calls: string[] } {
  const calls: string[] = [];
  const execFn: GitExecFn = async (cmd, opts) => {
    calls.push(cmd);
    for (const [pattern, handler] of handlers) {
      if (pattern.test(cmd)) return handler(cmd, opts);
    }
    throw new Error(`unhandled command: ${cmd}`);
  };
  return { execFn, calls };
}

const worktree = '/fake/worktree';

describe('captureWorktreeState', () => {
  it('returns null and logs when git rev-parse --show-toplevel rejects', async () => {
    const { execFn } = makeFakeExec([
      [
        /git rev-parse --show-toplevel/,
        () => {
          throw new Error('not a git repo');
        },
      ],
    ]);
    const logs: string[] = [];

    const result = await captureWorktreeState(execFn, worktree, (msg) => logs.push(msg));

    expect(result).toBeNull();
    expect(logs).toContain(`worktree state guard disabled: ${worktree} is not a git worktree root`);
  });

  it('returns null when toplevel resolves to a different directory than worktree', async () => {
    const { execFn } = makeFakeExec([
      [/git rev-parse --show-toplevel/, () => ({ stdout: '/somewhere/else\n', stderr: '' })],
    ]);
    const logs: string[] = [];

    const result = await captureWorktreeState(execFn, worktree, (msg) => logs.push(msg));

    expect(result).toBeNull();
    expect(logs).toContain(`worktree state guard disabled: ${worktree} is not a git worktree root`);
  });

  describe('with a real worktree directory', () => {
    let realWorktree: string;

    beforeEach(async () => {
      realWorktree = await mkdtemp(join(tmpdir(), 'wt-state-fake-'));
    });

    afterEach(async () => {
      await rm(realWorktree, { recursive: true, force: true });
    });

    it('returns null when baseline status has a tracked modification', async () => {
      const { execFn } = makeFakeExec([
        [/git rev-parse --show-toplevel/, () => ({ stdout: `${realWorktree}\n`, stderr: '' })],
        [/git rev-parse HEAD/, () => ({ stdout: 'abc123\n', stderr: '' })],
        [/git status --porcelain/, () => ({ stdout: ' M src/a.ts\n', stderr: '' })],
      ]);
      const logs: string[] = [];

      const result = await captureWorktreeState(execFn, realWorktree, (msg) => logs.push(msg));

      expect(result).toBeNull();
      expect(logs).toContain('worktree state guard disabled: baseline has uncommitted tracked changes');
    });

    it('returns a snapshot when baseline is clean or untracked-only', async () => {
      const { execFn } = makeFakeExec([
        [/git rev-parse --show-toplevel/, () => ({ stdout: `${realWorktree}\n`, stderr: '' })],
        [/git rev-parse HEAD/, () => ({ stdout: 'abc123\n', stderr: '' })],
        [/git status --porcelain/, () => ({ stdout: '?? notes.txt\n', stderr: '' })],
      ]);
      const logs: string[] = [];

      const result = await captureWorktreeState(execFn, realWorktree, (msg) => logs.push(msg));

      expect(result).toEqual({
        headSha: 'abc123',
        statusText: '?? notes.txt\n',
        untrackedPaths: ['notes.txt'],
      });
    });
  });
});

describe('captureWorktreeState with a real git repository', () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupPaths.map((path) => rm(path, { recursive: true, force: true })));
    cleanupPaths.length = 0;
  });

  async function makeRepo(): Promise<string> {
    const repoDir = await mkdtemp(join(tmpdir(), 'wt-state-repo-'));
    cleanupPaths.push(repoDir);
    await defaultExecFn('git init', { cwd: repoDir });
    await defaultExecFn('git config user.email test@example.com', { cwd: repoDir });
    await defaultExecFn('git config user.name test', { cwd: repoDir });
    await writeFileFs(join(repoDir, 'tracked.txt'), 'original\n');
    await defaultExecFn('git add -A', { cwd: repoDir });
    await defaultExecFn('git commit -m init', { cwd: repoDir });
    return repoDir;
  }

  it.skipIf(!symlinksSupported)('captures a snapshot when the worktree is a symlink to the repo root', async () => {
    const repoDir = await makeRepo();
    const linkPath = join(tmpdir(), `wt-state-link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await symlink(repoDir, linkPath);
    cleanupPaths.push(linkPath);
    const logs: string[] = [];

    const result = await captureWorktreeState(defaultExecFn, linkPath, (msg) => logs.push(msg));

    const { stdout: expectedHead } = await defaultExecFn('git rev-parse HEAD', { cwd: repoDir });
    expect(result).not.toBeNull();
    expect(result!.headSha).toBe(expectedHead.trim());
    expect(logs.some((msg) => msg.includes('worktree state guard disabled'))).toBe(false);
  });

  it('still disables the guard for a subdirectory', async () => {
    const repoDir = await makeRepo();
    const subdir = join(repoDir, 'subdir');
    await mkdirFs(subdir);
    const logs: string[] = [];

    const result = await captureWorktreeState(defaultExecFn, subdir, (msg) => logs.push(msg));

    expect(result).toBeNull();
    expect(logs).toContain(`worktree state guard disabled: ${subdir} is not a git worktree root`);
  });

  it.skipIf(!symlinksSupported)(
    'resetWorktreeState restores a tracked file dirtied after a snapshot captured via a symlink',
    async () => {
      const repoDir = await makeRepo();
      const linkPath = join(tmpdir(), `wt-state-link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      await symlink(repoDir, linkPath);
      cleanupPaths.push(linkPath);
      const logs: string[] = [];

      const snapshot = await captureWorktreeState(defaultExecFn, linkPath, (msg) => logs.push(msg));
      expect(snapshot).not.toBeNull();

      await writeFileFs(join(repoDir, 'tracked.txt'), 'dirtied\n');

      const result = await resetWorktreeState(defaultExecFn, linkPath, snapshot!, (msg) => logs.push(msg));

      expect(result.didReset).toBe(true);
      const restored = await readFile(join(repoDir, 'tracked.txt'), 'utf-8');
      expect(restored).toBe('original\n');
      if (result.tracePath) await rm(result.tracePath, { force: true });
    },
  );

  it('writes a private attempt trace inside the worktree that git never sees', async () => {
    const repoDir = await makeRepo();
    const logs: string[] = [];
    const snapshot = await captureWorktreeState(defaultExecFn, repoDir, (msg) => logs.push(msg));
    expect(snapshot).not.toBeNull();

    await writeFileFs(join(repoDir, 'tracked.txt'), 'SECRET_TOKEN=abc\n');
    const result = await resetWorktreeState(defaultExecFn, repoDir, snapshot!, (msg) => logs.push(msg));

    expect(result.didReset).toBe(true);
    expect(result.tracePath).toBeDefined();
    const traceDir = join(await realpath(repoDir), '.factory', 'attempt-traces');
    expect(result.tracePath!.startsWith(traceDir)).toBe(true);
    expect(await readFile(result.tracePath!, 'utf-8')).toContain('SECRET_TOKEN=abc');
    if (process.platform !== 'win32') {
      expect(statSync(result.tracePath!).mode & 0o777).toBe(0o600);
    }

    // The trace survives `git clean -fd`, never shows in status, and `git add -A` never stages it.
    const { stdout: status } = await defaultExecFn('git status --porcelain --ignored=no', { cwd: repoDir });
    expect(status).toBe('');
    await defaultExecFn('git add -A', { cwd: repoDir });
    const { stdout: staged } = await defaultExecFn('git diff --cached --name-only', { cwd: repoDir });
    expect(staged).toBe('');
  });

  it.skipIf(!symlinksSupported)('refuses to write a trace through a symlinked trace directory', async () => {
    const repoDir = await makeRepo();
    const outside = await mkdtemp(join(tmpdir(), 'wt-state-outside-'));
    cleanupPaths.push(outside);
    await mkdirFs(join(repoDir, '.factory'), { recursive: true });
    await symlink(outside, join(repoDir, '.factory', 'attempt-traces'));
    await writeFileFs(join(repoDir, '.gitignore'), '.factory/\n');
    await defaultExecFn('git add -A', { cwd: repoDir });
    await defaultExecFn('git commit -m ignore', { cwd: repoDir });
    const logs: string[] = [];
    const snapshot = await captureWorktreeState(defaultExecFn, repoDir, (msg) => logs.push(msg));
    expect(snapshot).not.toBeNull();

    await writeFileFs(join(repoDir, 'tracked.txt'), 'dirtied\n');
    const result = await resetWorktreeState(defaultExecFn, repoDir, snapshot!, (msg) => logs.push(msg));

    expect(result.didReset).toBe(true);
    expect(result.tracePath).toBeUndefined();
    expect(logs.some((msg) => msg.includes('failed to write attempt trace'))).toBe(true);
    expect(await readdir(outside)).toEqual([]);
  });
});

describe('resetWorktreeState', () => {
  const writtenFiles: string[] = [];

  afterEach(async () => {
    await Promise.all(writtenFiles.map((path) => rm(path, { recursive: true, force: true })));
    writtenFiles.length = 0;
  });

  const snapshot: WorktreeSnapshot = {
    headSha: 'abc123',
    statusText: '',
    untrackedPaths: ['notes.txt'],
  };

  it('no-ops when head and status match the snapshot', async () => {
    const { execFn, calls } = makeFakeExec([
      [/git rev-parse HEAD/, () => ({ stdout: 'abc123\n', stderr: '' })],
      [/git status --porcelain/, () => ({ stdout: '', stderr: '' })],
    ]);
    const logs: string[] = [];

    const result = await resetWorktreeState(execFn, worktree, snapshot, (msg) => logs.push(msg));

    expect(result).toEqual({ didReset: false });
    expect(calls.some((c) => c.includes('git reset'))).toBe(false);
  });

  it('resets and writes a trace when dirty', async () => {
    const { execFn, calls } = makeFakeExec([
      [/git rev-parse HEAD/, () => ({ stdout: 'def456\n', stderr: '' })],
      [/git status --porcelain/, () => ({ stdout: ' M src/x.ts\n?? junk.txt\n', stderr: '' })],
      [/git diff HEAD/, () => ({ stdout: 'diff --git a/src/x.ts b/src/x.ts\n+garbage\n', stderr: '' })],
      [/git reset --hard/, () => ({ stdout: '', stderr: '' })],
      [/git clean -fd/, () => ({ stdout: '', stderr: '' })],
    ]);
    const logs: string[] = [];

    const tmpWorktree = await mkdtemp(join(tmpdir(), 'wt-state-trace-'));
    writtenFiles.push(tmpWorktree);

    const result = await resetWorktreeState(execFn, tmpWorktree, snapshot, (msg) => logs.push(msg));

    expect(result.didReset).toBe(true);
    expect(result.tracePath).toBeDefined();
    expect(result.tracePath!.startsWith(join(await realpath(tmpWorktree), '.factory', 'attempt-traces'))).toBe(true);

    const resetCmd = calls.find((c) => c.startsWith('git reset --hard'));
    expect(resetCmd).toBe(`git reset --hard 'abc123'`);

    const cleanCmd = calls.find((c) => c.startsWith('git clean -fd'));
    expect(cleanCmd).toContain(`-e 'notes.txt'`);
    expect(cleanCmd).not.toContain('-x');

    expect(existsSync(result.tracePath!)).toBe(true);
    const traceContent = await readFile(result.tracePath!, 'utf-8');
    expect(traceContent).toContain('diff --git a/src/x.ts b/src/x.ts');
  });

  it('does not prevent reset when trace write fails', async () => {
    const { execFn, calls } = makeFakeExec([
      [/git rev-parse HEAD/, () => ({ stdout: 'def456\n', stderr: '' })],
      [/git status --porcelain/, () => ({ stdout: ' M src/x.ts\n', stderr: '' })],
      [
        /git diff HEAD/,
        () => {
          throw new Error('diff exploded');
        },
      ],
      [/git reset --hard/, () => ({ stdout: '', stderr: '' })],
      [/git clean -fd/, () => ({ stdout: '', stderr: '' })],
    ]);
    const logs: string[] = [];

    const result = await resetWorktreeState(execFn, worktree, snapshot, (msg) => logs.push(msg));

    expect(result.didReset).toBe(true);
    expect(result.tracePath).toBeUndefined();
    expect(logs.some((msg) => msg.includes('failed to write attempt trace'))).toBe(true);
    expect(calls.some((c) => c.startsWith('git reset --hard'))).toBe(true);
  });

  it('propagates a rejecting git reset --hard', async () => {
    const { execFn } = makeFakeExec([
      [/git rev-parse HEAD/, () => ({ stdout: 'def456\n', stderr: '' })],
      [/git status --porcelain/, () => ({ stdout: ' M src/x.ts\n', stderr: '' })],
      [/git diff HEAD/, () => ({ stdout: 'diff text\n', stderr: '' })],
      [
        /git reset --hard/,
        () => {
          throw new Error('reset exploded');
        },
      ],
    ]);
    const logs: string[] = [];

    await expect(resetWorktreeState(execFn, worktree, snapshot, (msg) => logs.push(msg))).rejects.toThrow(
      'reset exploded',
    );
  });
});
