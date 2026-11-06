import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setupWorktree } from '../utils/index.js';
import { reclaimRetainedWorktrees } from './worktree-retention.js';

const HERMETIC_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_TERMINAL_PROMPT: '0',
};

const saved: Record<string, string | undefined> = {};
let root: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...HERMETIC_ENV } }).trim();
}

beforeEach(() => {
  for (const [k, v] of Object.entries(HERMETIC_ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  root = realpathSync(mkdtempSync(join(tmpdir(), 'retention-real-')));
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('reclaimRetainedWorktrees on a real git repo', () => {
  it('an evicted PR-backed tree is recreated from origin at the pushed head', async () => {
    const origin = join(root, 'origin.git');
    const repo = join(root, 'repo');
    mkdirSync(origin);
    git(origin, 'init', '--bare', '-b', 'main');
    git(root, 'clone', origin, repo);
    writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'push', 'origin', 'HEAD:main');
    git(repo, 'fetch', 'origin');

    const branch = 'factory/7-thing';
    const wt = join(root, 'repo-factory-7');
    git(repo, 'worktree', 'add', '-b', branch, wt, 'origin/main');
    writeFileSync(join(wt, 'b.txt'), 'b');
    git(wt, 'add', '.');
    git(wt, 'commit', '-m', 'work');
    git(wt, 'push', 'origin', branch);
    const pushed = git(wt, 'rev-parse', 'HEAD');

    const report = await reclaimRetainedWorktrees({
      repoRoot: repo,
      policy: { maxRetained: 0 },
      pressure: true,
      keepsFile: join(root, 'keeps.json'),
    });

    expect(report.evicted.map((c) => c.path)).toEqual([wt]);
    expect(report.failed).toEqual([]);
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(pushed);

    const created = await setupWorktree(repo, branch, wt, `origin/${branch}`);
    expect(created.head).toBe(pushed);
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(pushed);
  }, 30_000);

  it('keeps a tree with an unpushed commit', async () => {
    const origin = join(root, 'origin.git');
    const repo = join(root, 'repo');
    mkdirSync(origin);
    git(origin, 'init', '--bare', '-b', 'main');
    git(root, 'clone', origin, repo);
    writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'push', 'origin', 'HEAD:main');
    git(repo, 'fetch', 'origin');
    const wt = join(root, 'repo-factory-8');
    git(repo, 'worktree', 'add', '-b', 'factory/8-x', wt, 'origin/main');
    writeFileSync(join(wt, 'c.txt'), 'c');
    git(wt, 'add', '.');
    git(wt, 'commit', '-m', 'local only');

    const report = await reclaimRetainedWorktrees({
      repoRoot: repo,
      policy: { maxRetained: 0 },
      pressure: true,
      keepsFile: join(root, 'keeps.json'),
    });

    expect(report.evicted).toEqual([]);
    expect(report.protected[0]).toMatchObject({ protectedBy: 'unrecoverable' });
    expect(existsSync(wt)).toBe(true);
  }, 30_000);
});
