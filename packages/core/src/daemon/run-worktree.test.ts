import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import { expect, it } from 'vitest';
import { prepareRunWorktree } from './run-worktree.js';

async function initRepo(): Promise<{ dir: string; git: (...args: string[]) => ReturnType<typeof execa> }> {
  const dir = await mkdtemp(join(tmpdir(), 'run-worktrees-'));
  const git = (...args: string[]) => execa('git', args, { cwd: dir });
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
  await writeFile(join(dir, 'story.txt'), 'base');
  await git('add', '.');
  await git('commit', '-m', 'base');
  return { dir, git };
}

async function commitSlice(worktree: string): Promise<void> {
  await writeFile(join(worktree, 'slice-1.txt'), 'one');
  await execa('git', ['add', '.'], { cwd: worktree });
  await execa('git', ['commit', '-m', 'slice-1'], { cwd: worktree });
}

it('branches a new run worktree from the supplied baseRef', async () => {
  const { dir, git } = await initRepo();
  try {
    const a = randomUUID();
    const b = randomUUID();
    const first = await prepareRunWorktree(dir, a);
    await commitSlice(first);
    const tip1 = String((await git('rev-parse', `codex/run-${a}`)).stdout);
    const second = await prepareRunWorktree(dir, b, { baseRef: `codex/run-${a}` });
    expect(String((await git('merge-base', `codex/run-${b}`, `codex/run-${a}`)).stdout)).toBe(tip1);
    expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: second })).stdout).toBe(tip1);
    expect(await readFile(join(second, 'slice-1.txt'), 'utf8')).toBe('one');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('branches from HEAD when no baseRef is supplied', async () => {
  const { dir, git } = await initRepo();
  try {
    const first = await prepareRunWorktree(dir, randomUUID());
    await commitSlice(first);
    const third = await prepareRunWorktree(dir, randomUUID());
    const mainTip = String((await git('rev-parse', 'main')).stdout);
    expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: third })).stdout).toBe(mainTip);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects an empty or option-like baseRef', async () => {
  const { dir } = await initRepo();
  try {
    for (const baseRef of ['', '  ', '--orphan'])
      await expect(prepareRunWorktree(dir, randomUUID(), { baseRef })).rejects.toThrow('Invalid base ref');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('isolates simultaneous same-repository deliveries with distinct branches and independent factory state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'run-worktrees-'));
  const git = (...args: string[]) => execa('git', args, { cwd: dir });
  try {
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'Test');
    await git('config', 'user.email', 'test@example.com');
    await writeFile(join(dir, 'story.txt'), 'base');
    await git('add', '.');
    await git('commit', '-m', 'base');
    const a = randomUUID();
    const b = randomUUID();
    const [first, second] = await Promise.all([prepareRunWorktree(dir, a), prepareRunWorktree(dir, b)]);
    expect(first).not.toBe(second);
    expect((await execa('git', ['branch', '--show-current'], { cwd: first })).stdout).toBe(`codex/run-${a}`);
    expect((await execa('git', ['branch', '--show-current'], { cwd: second })).stdout).toBe(`codex/run-${b}`);
    await writeFile(join(first, 'story.txt'), 'first');
    expect(await readFile(join(second, 'story.txt'), 'utf8')).toBe('base');
    expect(await readFile(join(dir, 'story.txt'), 'utf8')).toBe('base');
    expect((await git('branch', '--show-current')).stdout).toBe('main');
    expect(await prepareRunWorktree(dir, a)).toBe(first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
