import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { clearRepoSlugCache, resolveRepoSlug } from './repo-slug.js';

function initGitRepo(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
}

describe('resolveRepoSlug', () => {
  beforeEach(() => {
    clearRepoSlugCache();
  });

  it('resolves the slug from a real origin remote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-slug-'));
    initGitRepo(dir);
    execFileSync('git', ['remote', 'add', 'origin', 'ssh://git@ssh.github.com:443/on-par/software-factory.git'], {
      cwd: dir,
    });

    expect(resolveRepoSlug(dir)).toBe('on-par/software-factory');
  });

  it('returns null outside a git checkout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-slug-'));

    expect(() => resolveRepoSlug(dir)).not.toThrow();
    expect(resolveRepoSlug(dir)).toBeNull();
  });

  it('returns null for a git checkout with no origin remote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-slug-'));
    initGitRepo(dir);

    expect(resolveRepoSlug(dir)).toBeNull();
  });

  it('resolves from a subdirectory that does not exist yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-slug-'));
    initGitRepo(dir);
    execFileSync('git', ['remote', 'add', 'origin', 'ssh://git@ssh.github.com:443/on-par/software-factory.git'], {
      cwd: dir,
    });

    expect(resolveRepoSlug(join(dir, '.factory', 'state'))).toBe('on-par/software-factory');
  });

  it('memoizes per directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-slug-'));
    initGitRepo(dir);
    execFileSync('git', ['remote', 'add', 'origin', 'ssh://git@ssh.github.com:443/on-par/software-factory.git'], {
      cwd: dir,
    });

    expect(resolveRepoSlug(dir)).toBe('on-par/software-factory');

    execFileSync('git', ['remote', 'set-url', 'origin', 'ssh://git@ssh.github.com:443/acme/widgets.git'], {
      cwd: dir,
    });
    expect(resolveRepoSlug(dir)).toBe('on-par/software-factory');

    clearRepoSlugCache();
    expect(resolveRepoSlug(dir)).toBe('acme/widgets');
  });
});
