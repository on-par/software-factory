import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { excludeProjectRunState } from './project-run-state.js';

const tmp = createTempDirs();
afterEach(async () => {
  await tmp.cleanup();
});

function gitRepo(): string {
  const dir = realpathSync(tmp.makeSync('prs-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'init');
  return dir;
}

function status(repo: string): string {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' });
}

function excludeFile(repo: string): string {
  const file = join(repo, '.git', 'info', 'exclude');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

describe('excludeProjectRunState (#4341)', () => {
  it.each([
    { name: 'source set, state in the checkout', external: true, state: 'in', excluded: true, clean: true },
    { name: 'source unset', external: false, state: 'in', excluded: false, clean: false },
    { name: 'source set, state root outside', external: true, state: 'out', excluded: false, clean: true },
  ])('keeps run state out of git status ($name)', async ({ external, state, excluded, clean }) => {
    const repo = gitRepo();
    const project = tmp.makeSync('prs-project-');
    const stateDir = state === 'in' ? join(repo, '.factory', 'state') : join(tmp.makeSync('prs-root-'), 'state');
    mkdirSync(join(stateDir, 'logs'), { recursive: true });
    writeFileSync(join(stateDir, 'events.ndjson'), '{}\n');
    const before = excludeFile(repo);
    const env = external ? { FACTORY_PROJECT_CONFIG_DIR: project } : {};

    expect(await excludeProjectRunState(repo, stateDir, env)).toBe(excluded);

    expect(excludeFile(repo)).toBe(excluded ? `${before}/.factory/state/\n` : before);
    expect(status(repo) === '').toBe(clean);
  });

  it.each([
    { name: 'already excluded', exclude: '/.factory/state/\n' },
    { name: 'whole .factory excluded', exclude: '/.factory/\n' },
  ])('adds no second exclude line ($name)', async ({ exclude }) => {
    const repo = gitRepo();
    writeFileSync(join(repo, '.git', 'info', 'exclude'), exclude);
    const env = { FACTORY_PROJECT_CONFIG_DIR: tmp.makeSync('prs-project-') };

    expect(await excludeProjectRunState(repo, join(repo, '.factory', 'state'), env)).toBe(false);
    expect(excludeFile(repo)).toBe(exclude);
  });

  it('does nothing outside a git work tree', async () => {
    const dir = tmp.makeSync('prs-plain-');
    const env = { FACTORY_PROJECT_CONFIG_DIR: tmp.makeSync('prs-project-') };

    expect(await excludeProjectRunState(dir, join(dir, '.factory', 'state'), env)).toBe(false);
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });

  it('fails naming the source when the directory is missing', async () => {
    const repo = gitRepo();
    const missing = join(repo, 'missing');

    await expect(
      excludeProjectRunState(repo, join(repo, '.factory', 'state'), { FACTORY_PROJECT_CONFIG_DIR: missing }),
    ).rejects.toThrow(`FACTORY_PROJECT_CONFIG_DIR: no such directory: ${missing}`);
  });
});
