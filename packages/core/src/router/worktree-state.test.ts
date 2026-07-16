import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { captureWorktreeState, resetWorktreeState } from './worktree-state.js';
import type { GitExecFn, WorktreeSnapshot } from './worktree-state.js';

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

  it('returns null when baseline status has a tracked modification', async () => {
    const { execFn } = makeFakeExec([
      [/git rev-parse --show-toplevel/, () => ({ stdout: `${worktree}\n`, stderr: '' })],
      [/git rev-parse HEAD/, () => ({ stdout: 'abc123\n', stderr: '' })],
      [/git status --porcelain/, () => ({ stdout: ' M src/a.ts\n', stderr: '' })],
    ]);
    const logs: string[] = [];

    const result = await captureWorktreeState(execFn, worktree, (msg) => logs.push(msg));

    expect(result).toBeNull();
    expect(logs).toContain('worktree state guard disabled: baseline has uncommitted tracked changes');
  });

  it('returns a snapshot when baseline is clean or untracked-only', async () => {
    const { execFn } = makeFakeExec([
      [/git rev-parse --show-toplevel/, () => ({ stdout: `${worktree}\n`, stderr: '' })],
      [/git rev-parse HEAD/, () => ({ stdout: 'abc123\n', stderr: '' })],
      [/git status --porcelain/, () => ({ stdout: '?? notes.txt\n', stderr: '' })],
    ]);
    const logs: string[] = [];

    const result = await captureWorktreeState(execFn, worktree, (msg) => logs.push(msg));

    expect(result).toEqual({
      headSha: 'abc123',
      statusText: '?? notes.txt\n',
      untrackedPaths: ['notes.txt'],
    });
  });
});

describe('resetWorktreeState', () => {
  const writtenFiles: string[] = [];

  afterEach(async () => {
    await Promise.all(writtenFiles.map((path) => rm(path, { force: true })));
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

    const result = await resetWorktreeState(execFn, worktree, snapshot, (msg) => logs.push(msg));

    expect(result.didReset).toBe(true);
    expect(result.tracePath).toBeDefined();
    expect(result.tracePath!.startsWith(tmpdir())).toBe(true);
    if (result.tracePath) writtenFiles.push(result.tracePath);

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
