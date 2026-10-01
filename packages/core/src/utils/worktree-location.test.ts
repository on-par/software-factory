// packages/core/src/utils/worktree-location.test.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultFactoryConfig } from '@on-par/factory-config';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureWorktreeParentExcluded,
  formatWorktreeLocation,
  laneWorktreePath,
  resolveWorktreeRoot,
} from './worktree-location.js';

describe('resolveWorktreeRoot', () => {
  const repoRoot = '/code/software-factory';
  const repo = 'on-par/software-factory';

  it('namespaces the shipped default under home', () => {
    expect(defaultFactoryConfig.worktree.parent).toBe('~/.factory/worktrees');
    expect(resolveWorktreeRoot({ repoRoot, parent: defaultFactoryConfig.worktree.parent, repo, home: '/h' })).toBe(
      '/h/.factory/worktrees/on-par/software-factory',
    );
  });

  it('keeps ../ as the sibling layout', () => {
    expect(resolveWorktreeRoot({ repoRoot, parent: '../', repo })).toBe('/code');
  });

  it('uses a repo-relative parent as-is', () => {
    expect(resolveWorktreeRoot({ repoRoot, parent: '.factory/worktrees', repo })).toBe(
      '/code/software-factory/.factory/worktrees',
    );
  });

  it('namespaces absolute and bare-~ parents', () => {
    expect(resolveWorktreeRoot({ repoRoot, parent: '/srv/wt', repo })).toBe('/srv/wt/on-par/software-factory');
    expect(resolveWorktreeRoot({ repoRoot, parent: '~', repo, home: '/h' })).toBe('/h/on-par/software-factory');
  });

  it('falls back to the repo basename for a malformed slug', () => {
    expect(resolveWorktreeRoot({ repoRoot, parent: '/srv/wt', repo: 'nonsense' })).toBe('/srv/wt/software-factory');
  });
});

describe('laneWorktreePath', () => {
  const base = {
    repoRoot: '/code/r',
    parent: '~/.factory/worktrees',
    repo: 'o/r',
    issue: 12,
    prefix: 'factory',
    home: '/h',
  };

  it('puts the lane under the shared root with the stable basename', () => {
    expect(laneWorktreePath({ ...base, exists: () => false })).toBe('/h/.factory/worktrees/o/r/r-factory-factory-12');
  });

  it('falls back to an existing legacy sibling', () => {
    expect(laneWorktreePath({ ...base, exists: (p) => p === '/code/r-factory-factory-12' })).toBe(
      '/code/r-factory-factory-12',
    );
  });

  it('prefers the primary when both exist', () => {
    expect(laneWorktreePath({ ...base, exists: () => true })).toBe('/h/.factory/worktrees/o/r/r-factory-factory-12');
  });

  it('reproduces the sibling layout for ../', () => {
    expect(laneWorktreePath({ ...base, parent: '../', exists: () => false })).toBe('/code/r-factory-factory-12');
  });
});

describe('ensureWorktreeParentExcluded', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function initRepo(): string {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'wtloc-')));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'init');
    return dir;
  }

  it('ignores a parent outside the repo', async () => {
    const repo = initRepo();
    expect(await ensureWorktreeParentExcluded(repo, join(repo, '..', 'elsewhere'))).toBe(false);
    expect(await ensureWorktreeParentExcluded(repo, repo)).toBe(false);
  });

  it('excludes an in-repo parent idempotently and keeps git status clean', async () => {
    const repo = initRepo();
    const parent = join(repo, '.factory', 'worktrees');
    mkdirSync(parent, { recursive: true });
    expect(await ensureWorktreeParentExcluded(repo, parent)).toBe(true);
    expect(await ensureWorktreeParentExcluded(repo, parent)).toBe(false);
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('/.factory/worktrees/\n');
    execFileSync(
      'git',
      ['worktree', 'add', '-q', '-b', 'factory/12-x', join(parent, 'repo-factory-factory-12'), 'HEAD'],
      {
        cwd: repo,
      },
    );
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toBe('');
  });

  it('adds a newline before appending and honours an existing .factory/ entry', async () => {
    const repo = initRepo();
    const file = join(repo, '.git', 'info', 'exclude');
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(file, 'foo');
    expect(await ensureWorktreeParentExcluded(repo, join(repo, 'wt'))).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('foo\n/wt/\n');
    writeFileSync(file, '.factory/\n');
    expect(await ensureWorktreeParentExcluded(repo, join(repo, '.factory', 'worktrees'))).toBe(false);
  });
});

describe('formatWorktreeLocation', () => {
  it('renders the status line', () => {
    expect(formatWorktreeLocation('/h/w/o/r', '~/w')).toBe('Worktrees: /h/w/o/r  (worktree.parent: ~/w)');
  });
});
