import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildEgressAllowlist, detectEcosystems } from './egress-proxy.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repoWith(...files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'egress-dotnet-'));
  dirs.push(dir);
  for (const f of files) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), '');
  }
  return dir;
}

describe('nested .NET projects (#3472)', () => {
  it('detects dotnet from a nested src/App/App.csproj', () => {
    expect(detectEcosystems(repoWith('src/App/App.csproj'))).toEqual(['dotnet']);
  });

  it('does not detect dotnet when the only csproj is under node_modules or bin', () => {
    expect(detectEcosystems(repoWith('node_modules/pkg/App.csproj', 'bin/App.csproj'))).toEqual([]);
  });

  it('adds NuGet hosts for a repo whose only project is src/App/App.csproj', () => {
    expect(buildEgressAllowlist(['github.com'], repoWith('src/App/App.csproj'))).toEqual([
      'github.com',
      'api.nuget.org',
      '*.nuget.org',
    ]);
  });
});
