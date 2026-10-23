// packages/cli/src/cli/doctor-verify.test.ts — the doctor Verify section (#3473)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { runDoctorChecks } from './doctor.js';
import {
  npmCheck,
  resolveVerifyCommands,
  VERIFY_SECTION,
  verifyCommandChecks,
  withPathResults,
  type VerifyCommandRow,
} from './doctor-verify.js';

const tmp = createTempDirs();
afterEach(() => tmp.cleanup());

function repo(files: Record<string, string>): string {
  const dir = tmp.makeSync('doctor-verify-');
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  return dir;
}

const allOnPath = () => true;
const rowOf = (rows: VerifyCommandRow[], kind: string) => rows.find((r) => r.kind === kind)!;

describe('resolveVerifyCommands', () => {
  it('shows bash scripts/verify.sh --no-e2e from scripts/verify.sh', async () => {
    const { rows, error } = await resolveVerifyCommands(repo({ 'scripts/verify.sh': '#!/bin/sh\n' }));
    expect(error).toBeUndefined();
    expect(rowOf(rows, 'test')).toEqual({
      kind: 'test',
      command: 'bash scripts/verify.sh --no-e2e',
      source: 'scripts/verify.sh',
      executable: 'bash',
    });
  });

  it('resolves build from Makefile and Cargo.toml', async () => {
    expect(rowOf((await resolveVerifyCommands(repo({ Makefile: 'all:\n' }))).rows, 'build')).toMatchObject({
      command: 'make',
      source: 'Makefile',
      executable: 'make',
    });
    expect(rowOf((await resolveVerifyCommands(repo({ 'Cargo.toml': '' }))).rows, 'build')).toMatchObject({
      command: 'cargo build',
      source: 'Cargo.toml',
      executable: 'cargo',
    });
  });

  it('resolves build, test and lint rows from package.json and tsconfig.json', async () => {
    const dir = repo({
      'package.json': JSON.stringify({ scripts: { build: 'b', test: 't', lint: 'l' } }),
      'tsconfig.json': '{}',
    });
    const { rows } = await resolveVerifyCommands(dir);
    expect(rows.map((r) => [r.kind, r.command, r.source])).toEqual([
      ['build', 'npm run build', 'package.json'],
      ['test', 'npm test', 'package.json'],
      ['lint', 'npm run lint', 'package.json'],
      ['lint', 'npx tsc --noEmit', 'tsconfig.json'],
    ]);
  });

  it('maps verify.ps1 and returns null rows for an empty repo', async () => {
    const ps1 = await resolveVerifyCommands(repo({ 'scripts/verify.ps1': '' }));
    expect(rowOf(ps1.rows, 'test')).toMatchObject({ source: 'scripts/verify.ps1', executable: 'pwsh' });
    const empty = await resolveVerifyCommands(repo({ 'App.csproj': '' }));
    expect(empty.rows).toEqual([
      { kind: 'build', command: null, source: null, executable: null },
      { kind: 'test', command: null, source: null, executable: null },
      { kind: 'lint', command: null, source: null, executable: null },
    ]);
  });

  it('shows commands declared under checks in .factory/config.json ahead of the file-based guesses', async () => {
    const dir = repo({
      '.factory/config.json': JSON.stringify({
        version: 2,
        checks: {
          build: 'dotnet build App.sln',
          test: 'pwsh ./.githooks/run-tests.ps1',
          lint: 'dotnet format --verify-no-changes',
        },
      }),
      'scripts/verify.sh': '',
      'package.json': JSON.stringify({ scripts: { build: 'b', test: 't', lint: 'l' } }),
      'tsconfig.json': '{}',
    });
    const { rows } = await resolveVerifyCommands(dir);
    expect(rows.map((r) => [r.kind, r.command, r.source, r.executable])).toEqual([
      ['build', 'dotnet build App.sln', '.factory/config.json', 'dotnet'],
      ['test', 'pwsh ./.githooks/run-tests.ps1', '.factory/config.json', 'pwsh'],
      ['lint', 'dotnet format --verify-no-changes', '.factory/config.json', 'dotnet'],
    ]);
    const test = verifyCommandChecks({ rows }, { requireTests: false, commandAvailable: allOnPath })[1]!;
    expect(test.detail).toBe('`pwsh ./.githooks/run-tests.ps1` (from .factory/config.json); pwsh found on PATH');
  });

  it('names a YAML repo config as the source', async () => {
    const dir = repo({ '.factory/config.yaml': 'version: 2\nchecks:\n  test: dotnet test\n' });
    expect(rowOf((await resolveVerifyCommands(dir)).rows, 'test')).toMatchObject({
      command: 'dotnet test',
      source: '.factory/config.yaml',
    });
  });

  it('an invalid checks command comes back as an error naming the config file', async () => {
    const dir = repo({
      '.factory/config.json': JSON.stringify({ version: 2, checks: { test: 'dotnet test | tee x' } }),
    });
    const resolved = await resolveVerifyCommands(dir);
    expect(resolved.rows).toEqual([]);
    expect(resolved.error).toContain('checks.test');
  });

  it('a malformed package.json comes back as an error, not a throw', async () => {
    const resolved = await resolveVerifyCommands(repo({ 'package.json': '{ nope' }));
    expect(resolved.rows).toEqual([]);
    expect(resolved.error).toBeTruthy();
  });
});

describe('verifyCommandChecks', () => {
  const opts = { requireTests: false, commandAvailable: allOnPath };

  it('verify section shows bash scripts/verify.sh --no-e2e from scripts/verify.sh with bash on PATH', async () => {
    const resolved = await resolveVerifyCommands(repo({ 'scripts/verify.sh': '' }));
    const test = verifyCommandChecks(resolved, opts).find((c) => c.name === 'verify test')!;
    expect(test).toMatchObject({ ok: true, section: VERIFY_SECTION });
    expect(test.detail).toBe('`bash scripts/verify.sh --no-e2e` (from scripts/verify.sh); bash found on PATH');
  });

  it('a .NET repo with no test surface warns CHECK will run no tests and names scripts/verify.sh', async () => {
    const checks = verifyCommandChecks(await resolveVerifyCommands(repo({ 'App.csproj': '' })), opts);
    const test = checks.find((c) => c.name === 'verify test')!;
    expect(test).toMatchObject({ ok: false, optional: true });
    expect(test.detail).toContain('CHECK will run no tests');
    expect(test.fix).toContain('scripts/verify.sh');
    expect(test.fix).toContain('factory init --detect-checks');
    expect(checks.find((c) => c.name === 'verify build')).toMatchObject({ ok: false, optional: true });
    expect(checks.find((c) => c.name === 'verify lint')).toMatchObject({ ok: true, optional: true });
  });

  it('a verify.ps1 repo without pwsh on PATH fails the test row and names pwsh', async () => {
    const resolved = await resolveVerifyCommands(repo({ 'scripts/verify.ps1': '' }));
    const checks = verifyCommandChecks(resolved, { ...opts, commandAvailable: (c) => c !== 'pwsh' });
    const test = checks.find((c) => c.name === 'verify test')!;
    expect(test.ok).toBe(false);
    expect(test.optional).toBeUndefined();
    expect(test.detail).toContain('pwsh');
    expect(test.fix).toContain('pwsh');
    expect(test.fix).toContain('https://aka.ms/powershell');
  });

  it('a missing non-pwsh executable fails with a plain install fix', async () => {
    const resolved = await resolveVerifyCommands(repo({ Makefile: '' }));
    const build = verifyCommandChecks(resolved, { ...opts, commandAvailable: (c) => c !== 'make' })[0]!;
    expect(build).toMatchObject({ name: 'verify build', ok: false, fix: 'install make and put it on PATH' });
  });

  it('requireTests with no test command is a non-optional failure', async () => {
    const resolved = await resolveVerifyCommands(repo({ 'App.csproj': '' }));
    const test = verifyCommandChecks(resolved, { ...opts, requireTests: true }).find((c) => c.name === 'verify test')!;
    expect(test.ok).toBe(false);
    expect(test.optional).toBeUndefined();
    expect(test.detail).toContain('requireTests: true');
  });

  it('names lint rows by source', async () => {
    const resolved = await resolveVerifyCommands(repo({ 'tsconfig.json': '{}' }));
    expect(verifyCommandChecks(resolved, opts).map((c) => c.name)).toContain('verify lint (tsconfig.json)');
  });

  it('a resolver error is one failed verify commands row', () => {
    const checks = verifyCommandChecks({ rows: [], error: 'bad json' }, opts);
    expect(checks).toEqual([expect.objectContaining({ name: 'verify commands', ok: false, section: VERIFY_SECTION })]);
    expect(checks[0]!.detail).toContain('bad json');
  });
});

describe('withPathResults and npmCheck', () => {
  it('fills onPath, null when there is no command', () => {
    const rows: VerifyCommandRow[] = [
      { kind: 'build', command: 'make', source: 'Makefile', executable: 'make' },
      { kind: 'test', command: null, source: null, executable: null },
    ];
    expect(withPathResults(rows, () => false).map((r) => r.onPath)).toEqual([false, null]);
  });

  it('npm missing is optional only without a package.json', () => {
    expect(npmCheck(true, false)).toMatchObject({ ok: true });
    expect(npmCheck(false, false)).toMatchObject({ ok: false, optional: true });
    expect(npmCheck(false, true).optional).toBeUndefined();
  });
});

describe('runDoctorChecks npm row', () => {
  const probes = (pathExists: (p: string) => boolean) => ({
    commandAvailable: (cmd: string) => cmd !== 'npm',
    envPresent: () => true,
    tryExec: (cmd: string) => (cmd.includes('git rev-parse') ? '/repo' : ''),
    pathExists,
    platform: 'darwin' as const,
  });

  it('npm missing is optional when the repo has no package.json', () => {
    const npm = runDoctorChecks(probes((p) => !p.endsWith('package.json'))).find((c) => c.name === 'npm')!;
    expect(npm).toMatchObject({ ok: false, optional: true });
    expect(npm.detail).toContain('no package.json');
  });

  it('npm missing still fails when the repo has a package.json', () => {
    const npm = runDoctorChecks(probes(() => true)).find((c) => c.name === 'npm')!;
    expect(npm.ok).toBe(false);
    expect(npm.optional).toBeUndefined();
  });
});
