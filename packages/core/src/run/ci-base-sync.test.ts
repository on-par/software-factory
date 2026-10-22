import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { execGit } from '../utils/git-exec.js';
import { mergeBaseIntoWorktree } from './ci-base-sync.js';

const tmp = createTempDirs();
afterAll(() => tmp.cleanup());

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await execGit(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd })).stdout.trim();

async function setup(): Promise<{ origin: string; wt: string }> {
  const root = await tmp.make('ci-base-sync-');
  const origin = join(root, 'origin');
  const wt = join(root, 'wt');
  await execGit(['init', '-b', 'main', origin]);
  writeFileSync(join(origin, 'a.txt'), 'one\n');
  await git(origin, 'add', '.');
  await git(origin, 'commit', '-m', 'init');
  await execGit(['clone', origin, wt]);
  await git(wt, 'checkout', '-b', 'feature');
  return { origin, wt };
}

describe('mergeBaseIntoWorktree (#3537)', () => {
  it('reports merged=false when already up to date', async () => {
    const { wt } = await setup();
    expect(await mergeBaseIntoWorktree(wt, 'main')).toEqual({ ok: true, merged: false });
  });

  it('merges a base that moved ahead', async () => {
    const { origin, wt } = await setup();
    writeFileSync(join(origin, 'b.txt'), 'b\n');
    await git(origin, 'add', '.');
    await git(origin, 'commit', '-m', 'main moves');
    expect(await mergeBaseIntoWorktree(wt, 'main')).toEqual({ ok: true, merged: true });
  });

  it('returns conflict paths and leaves no merge in progress', async () => {
    const { origin, wt } = await setup();
    writeFileSync(join(origin, 'a.txt'), 'main\n');
    await git(origin, 'commit', '-am', 'main edit');
    writeFileSync(join(wt, 'a.txt'), 'feature\n');
    await git(wt, 'commit', '-am', 'feature edit');
    const result = await mergeBaseIntoWorktree(wt, 'main');
    expect(result).toMatchObject({ ok: false, conflicts: ['a.txt'] });
    await expect(git(wt, 'rev-parse', '--verify', 'MERGE_HEAD')).rejects.toThrow();
  });

  it('reports a failed fetch with no conflicts', async () => {
    const { wt } = await setup();
    expect(await mergeBaseIntoWorktree(wt, 'nope')).toMatchObject({ ok: false, conflicts: [] });
  });
});
