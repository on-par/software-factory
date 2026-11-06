// packages/core/src/run/stack-rebase.test.ts — shared rebase --onto + atomic leased push, on a real git fixture.

import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rebaseAndPushStack } from './stack-rebase.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(cwd: string, file: string, content: string, msg: string): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-m', msg);
}

const tempDirs = createTempDirs();

describe('rebaseAndPushStack', () => {
  let remote: string;
  let root: string;
  let oldMain: string;
  let head1: string;
  let head2: string;

  const remoteHead = (b: string): string => git(remote, 'rev-parse', `refs/heads/${b}`);
  const remoteLog = (b: string): string[] =>
    git(remote, 'log', '--format=%s', `main..${b}`).split('\n').filter(Boolean);

  beforeEach(() => {
    const dir = tempDirs.makeSync('stack-rebase-');
    remote = join(dir, 'remote.git');
    root = join(dir, 'root');
    git(dir, 'init', '--bare', '-b', 'main', remote);
    git(dir, 'clone', remote, root);
    for (const [k, v] of [
      ['user.name', 'T'],
      ['user.email', 't@example.com'],
      ['commit.gpgsign', 'false'],
    ] as const)
      git(root, 'config', k, v);
    git(root, 'checkout', '-b', 'main');
    commit(root, 'a.txt', 'base\n', 'base');
    git(root, 'push', 'origin', 'main');
    oldMain = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-b', 'factory/1-a');
    commit(root, 'one.txt', '1\n', 'one');
    head1 = git(root, 'rev-parse', 'HEAD');
    git(root, 'push', 'origin', 'factory/1-a');
    git(root, 'checkout', '-b', 'factory/2-b');
    commit(root, 'two.txt', '2\n', 'two');
    head2 = git(root, 'rev-parse', 'HEAD');
    git(root, 'push', 'origin', 'factory/2-b');
    git(root, 'checkout', 'main');
    commit(root, 'other.txt', 'o\n', 'main moves');
    git(root, 'push', 'origin', 'main');
    git(root, 'fetch', 'origin');
  });

  afterEach(() => tempDirs.cleanup());

  it('rebases one layer onto the new base with --onto and pushes it', async () => {
    const out = await rebaseAndPushStack({
      repoRoot: root,
      remote: 'origin',
      startBase: 'origin/main',
      layers: [{ branch: 'factory/1-a', recordedHead: head1, upstream: oldMain }],
    });
    expect(out.ok).toBe(true);
    expect(out.ok && remoteHead('factory/1-a')).toBe(out.ok ? out.newHeads[0] : '');
    expect(remoteLog('factory/1-a')).toEqual(['one']);
  });

  it('rebases two layers bottom-up and pushes both atomically', async () => {
    const out = await rebaseAndPushStack({
      repoRoot: root,
      remote: 'origin',
      startBase: 'origin/main',
      layers: [
        { branch: 'factory/1-a', recordedHead: head1, upstream: oldMain },
        { branch: 'factory/2-b', recordedHead: head2, upstream: head1 },
      ],
    });
    expect(out.ok).toBe(true);
    expect(git(remote, 'rev-parse', 'factory/2-b^')).toBe(remoteHead('factory/1-a'));
    expect(remoteLog('factory/2-b')).toEqual(['two', 'one']);
  });

  it('returns the conflicting files and pushes nothing on a conflict', async () => {
    git(root, 'checkout', 'factory/1-a');
    commit(root, 'a.txt', 'branch edit\n', 'edit a');
    git(root, 'push', 'origin', 'factory/1-a');
    const recorded = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', 'main');
    commit(root, 'a.txt', 'main edit\n', 'main edits a');
    git(root, 'push', 'origin', 'main');
    git(root, 'fetch', 'origin');
    const out = await rebaseAndPushStack({
      repoRoot: root,
      remote: 'origin',
      startBase: 'origin/main',
      layers: [{ branch: 'factory/1-a', recordedHead: recorded, upstream: oldMain }],
    });
    expect(out).toMatchObject({ ok: false, at: 0, phase: 'rebase', files: ['a.txt'] });
    expect(remoteHead('factory/1-a')).toBe(recorded);
  });

  it('refuses the push when the remote head moved past the recorded one', async () => {
    git(root, 'checkout', 'factory/1-a');
    commit(root, 'human.txt', 'h\n', 'human');
    git(root, 'push', 'origin', 'factory/1-a');
    const moved = remoteHead('factory/1-a');
    const out = await rebaseAndPushStack({
      repoRoot: root,
      remote: 'origin',
      startBase: 'origin/main',
      layers: [{ branch: 'factory/1-a', recordedHead: head1, upstream: oldMain }],
    });
    expect(out).toMatchObject({ ok: false, phase: 'push' });
    expect(!out.ok && out.reason).toContain('lease');
    expect(remoteHead('factory/1-a')).toBe(moved);
  });

  it('leaves no scratch worktree behind in the git dir', async () => {
    await rebaseAndPushStack({
      repoRoot: root,
      remote: 'origin',
      startBase: 'origin/main',
      layers: [{ branch: 'factory/1-a', recordedHead: head1, upstream: oldMain }],
    });
    expect(readdirSync(join(root, '.git')).filter((n) => n.startsWith('factory-restack-'))).toEqual([]);
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain('factory-restack-');
  });
});
