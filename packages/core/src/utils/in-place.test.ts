import { execFile as execFileCb } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PipelineTestKit } from '../test-support/index.js';
import { checkInPlaceCheckout, setupInPlaceCheckout } from './in-place.js';

const execFile = promisify(execFileCb);
const git = (cwd: string, ...args: string[]) => execFile('git', args, { cwd }).then((r) => r.stdout.trim());

describe('in-place checkout', () => {
  const kit = new PipelineTestKit();
  afterEach(() => kit.cleanup());

  it('reports dirty and untracked files with their status codes', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    await writeFile(join(repoRoot, 'README.md'), 'changed\n');
    await writeFile(join(repoRoot, 'new.txt'), 'x\n');
    const problem = await checkInPlaceCheckout(repoRoot);
    expect(problem?.kind).toBe('dirty');
    expect(problem?.kind === 'dirty' && problem.files.sort()).toEqual(['README.md', 'new.txt']);
    expect(problem?.message).toContain('M README.md');
    expect(problem?.message).toContain('?? new.txt');
  });

  it('shows a status code per file and caps the listing at 20', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    const names = Array.from({ length: 21 }, (_, i) => `u${String(i).padStart(2, '0')}.txt`);
    await Promise.all(names.map((name) => writeFile(join(repoRoot, name), 'x\n')));
    const problem = await checkInPlaceCheckout(repoRoot);
    expect(problem?.kind).toBe('dirty');
    expect(problem?.kind === 'dirty' && problem.files).toHaveLength(21);
    expect(problem?.message).toContain('(+1 more)');
    expect(problem?.message).toContain('?? u00.txt');
    expect(problem?.message).not.toContain('?? u20.txt');
  });

  it('refuses a checkout on another branch', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    await git(repoRoot, 'switch', '-c', 'other');
    const problem = await checkInPlaceCheckout(repoRoot);
    expect(problem).toMatchObject({ kind: 'wrong-branch', current: 'other', expected: 'main' });
    expect(problem?.message).toContain("on 'other'");
  });

  it('refuses a detached HEAD', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    await git(repoRoot, 'checkout', '--detach');
    expect(await checkInPlaceCheckout(repoRoot)).toMatchObject({ kind: 'wrong-branch', current: 'HEAD' });
  });

  it('refuses a HEAD behind the fetched origin default tip', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    await writeFile(join(repoRoot, 'a.txt'), 'a\n');
    await git(repoRoot, 'add', '-A');
    await git(repoRoot, 'commit', '-m', 'second');
    await git(repoRoot, 'push', 'origin', 'main');
    await git(repoRoot, 'reset', '--hard', 'HEAD~1');
    const problem = await checkInPlaceCheckout(repoRoot);
    expect(problem).toMatchObject({ kind: 'not-at-tip', expected: 'origin/main' });
    expect(problem?.message).toContain('git reset --hard origin/main');
  });

  it('returns null for a clean clone at origin default', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    expect(await checkInPlaceCheckout(repoRoot)).toBeNull();
  });

  it('switches the checkout to the factory branch from origin default', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    const log = vi.fn();
    const res = await setupInPlaceCheckout(repoRoot, 'factory/1-x', log);
    expect(res).toMatchObject({ base: 'origin/main', remoteBranch: null });
    expect(res.head).toBe(await git(repoRoot, 'rev-parse', 'HEAD'));
    expect(await git(repoRoot, 'branch', '--show-current')).toBe('factory/1-x');
    expect(log).toHaveBeenCalledWith('worktree-base', expect.stringContaining('in-place: switched'));
  });

  it('refuses when the factory branch already exists locally and deletes nothing', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    await git(repoRoot, 'branch', 'factory/1-x');
    await expect(setupInPlaceCheckout(repoRoot, 'factory/1-x')).rejects.toThrow(/could not create branch/);
    expect(await git(repoRoot, 'branch', '--list', 'factory/1-x')).toContain('factory/1-x');
    expect(await git(repoRoot, 'branch', '--show-current')).toBe('main');
  });

  it('creates no directory under the worktrees parent', async () => {
    const { repoRoot } = await kit.makeThrowawayRepo();
    await setupInPlaceCheckout(repoRoot, 'factory/2-y');
    const list = await git(repoRoot, 'worktree', 'list', '--porcelain');
    expect(list.split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
    expect(existsSync(`${repoRoot}-wt-2`)).toBe(false);
  });
});
