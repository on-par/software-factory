import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  it('adds all three isolation keys for a .NET root with a runId', () => {
    expect(dotnetEnv(makeRoot(['App.sln']), {}, 'abc123')).toEqual({
      DOTNET_TieredPGO: '0',
      MSBUILDDISABLENODEREUSE: '1',
      SharedCompilationId: 'factory-abc123',
    });
  });

  it('gives different runIds different SharedCompilationId values', () => {
    const root = makeRoot(['App.sln']);
    expect(dotnetEnv(root, {}, 'a').SharedCompilationId).not.toBe(dotnetEnv(root, {}, 'b').SharedCompilationId);
  });

  it.each([undefined, ''])('omits SharedCompilationId when runId is %j', (runId) => {
    const env = dotnetEnv(makeRoot(['App.sln']), {}, runId);
    expect(env).not.toHaveProperty('SharedCompilationId');
    expect(env.MSBUILDDISABLENODEREUSE).toBe('1');
    expect(env.DOTNET_TieredPGO).toBe('0');
  });

  it.each([
    ['DOTNET_TieredPGO', '1'],
    ['DOTNET_TieredPGO', ''],
    ['MSBUILDDISABLENODEREUSE', '0'],
    ['MSBUILDDISABLENODEREUSE', ''],
    ['SharedCompilationId', 'mine'],
    ['SharedCompilationId', ''],
  ])('leaves only %s out when the parent sets it to %j', (key, value) => {
    const env = dotnetEnv(makeRoot(['App.sln']), { [key]: value }, 'abc');
    const all = {
      DOTNET_TieredPGO: '0',
      MSBUILDDISABLENODEREUSE: '1',
      SharedCompilationId: 'factory-abc',
    } as Record<string, string>;
    delete all[key];
    expect(env).toEqual(all);
  });

  it('returns nothing for a non-.NET root, even with a runId', () => {
    expect(dotnetEnv(makeRoot(['package.json']), {}, 'abc')).toEqual({});
  });

  it('leaves the key out when the parent already sets DOTNET_TieredPGO', () => {
    expect(dotnetEnv(makeRoot(['App.sln']), { DOTNET_TieredPGO: '1' })).toEqual({ MSBUILDDISABLENODEREUSE: '1' });
  });
});

describe('compiler server lifecycle', () => {
  it('no non-test source file shuts down compiler servers', () => {
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const needle = 'build-server' + ' shutdown';
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && readFileSync(p, 'utf8').includes(needle)) {
          offenders.push(p);
        }
      }
    };
    for (const pkg of readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })) {
      if (pkg.isDirectory()) {
        try {
          walk(join(repoRoot, 'packages', pkg.name, 'src'));
        } catch {
          // package without a src dir
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
