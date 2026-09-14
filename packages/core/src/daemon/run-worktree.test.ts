import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import { expect, it } from 'vitest';
import { prepareRunWorktree } from './run-worktree.js';

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
