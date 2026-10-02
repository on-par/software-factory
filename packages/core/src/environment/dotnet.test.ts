import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { dotnetEnv, isDotnetWorktree } from './dotnet.js';

const roots: string[] = [];

function makeRoot(files: string[] = [], dirs: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'dotnet-env-'));
  roots.push(root);
  for (const f of files) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    writeFileSync(join(root, f), '');
  }
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  return root;
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('isDotnetWorktree', () => {
  it.each(['App.sln', 'App.slnx', 'App.csproj', 'global.json'])('is true when the root contains %s', (marker) => {
    expect(isDotnetWorktree(makeRoot([marker]))).toBe(true);
  });

  it('matches marker extensions case-insensitively', () => {
    expect(isDotnetWorktree(makeRoot(['App.CSPROJ']))).toBe(true);
  });

  it('is false for a non-.NET root', () => {
    expect(isDotnetWorktree(makeRoot(['package.json']))).toBe(false);
  });

  it('is false for an empty directory', () => {
    expect(isDotnetWorktree(makeRoot())).toBe(false);
  });

  it('is false for a non-existent path without throwing', () => {
    expect(isDotnetWorktree(join(tmpdir(), 'dotnet-env-does-not-exist'))).toBe(false);
  });

  it('is false when the only project file is nested', () => {
    expect(isDotnetWorktree(makeRoot(['src/App/App.csproj']))).toBe(false);
  });

  it('ignores a directory named global.json', () => {
    expect(isDotnetWorktree(makeRoot([], ['global.json']))).toBe(false);
  });
});

describe('dotnetEnv', () => {
  it('disables Dynamic PGO for a .NET root', () => {
    expect(dotnetEnv(makeRoot(['App.sln']), {})).toEqual({ DOTNET_TieredPGO: '0' });
  });

  it('returns nothing for a non-.NET root', () => {
    expect(dotnetEnv(makeRoot(['package.json']), {})).toEqual({});
  });

  it('leaves the key out when the parent already sets DOTNET_TieredPGO', () => {
    expect(dotnetEnv(makeRoot(['App.sln']), { DOTNET_TieredPGO: '1' })).toEqual({});
  });
});
