import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { InvalidWorkspaceError, resolveLocalOnlyPolicy } from './local-only.js';

const tempDirs = new Set<string>();

function mkTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'local-only-'));
  tempDirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe('resolveLocalOnlyPolicy', () => {
  it('returns a local-only policy for a workspace with a .git directory', () => {
    const dir = mkTempDir();
    mkdirSync(join(dir, '.git'));

    expect(resolveLocalOnlyPolicy(dir)).toEqual({ mode: 'local-only', workspace: dir });
  });

  it('accepts a .git file (linked worktree)', () => {
    const dir = mkTempDir();
    writeFileSync(join(dir, '.git'), 'gitdir: /somewhere/else\n');

    expect(resolveLocalOnlyPolicy(dir)).toEqual({ mode: 'local-only', workspace: dir });
  });

  it('resolves a relative path input to an absolute workspace', () => {
    const dir = mkTempDir();
    mkdirSync(join(dir, '.git'));
    const relativeInput = relative(process.cwd(), dir);

    const policy = resolveLocalOnlyPolicy(relativeInput);
    expect(policy.workspace).toBe(resolve(relativeInput));
    expect(policy.workspace).toBe(dir);
  });

  it('throws InvalidWorkspaceError with "does not exist" for a nonexistent path', () => {
    const dir = join(tmpdir(), 'local-only-does-not-exist-xyz');

    expect(() => resolveLocalOnlyPolicy(dir)).toThrow(/does not exist/);
    expect(() => resolveLocalOnlyPolicy(dir)).toThrow(InvalidWorkspaceError);
  });

  it('throws with "not a directory" for a path pointing at a regular file', () => {
    const dir = mkTempDir();
    const filePath = join(dir, 'a-file.txt');
    writeFileSync(filePath, 'hello');

    expect(() => resolveLocalOnlyPolicy(filePath)).toThrow(/not a directory/);
  });

  it('throws with "not an initialized git repository" for a dir without .git', () => {
    const dir = mkTempDir();

    expect(() => resolveLocalOnlyPolicy(dir)).toThrow(/not an initialized git repository/);
  });

  it('throws with "non-empty string" for an empty or whitespace-only input', () => {
    expect(() => resolveLocalOnlyPolicy('')).toThrow(/non-empty string/);
    expect(() => resolveLocalOnlyPolicy('   ')).toThrow(/non-empty string/);
  });

  it('produces error instances with name InvalidWorkspaceError', () => {
    try {
      resolveLocalOnlyPolicy('');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidWorkspaceError);
      expect((err as InvalidWorkspaceError).name).toBe('InvalidWorkspaceError');
    }
  });
});
