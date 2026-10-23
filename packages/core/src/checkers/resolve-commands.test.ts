import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirs } from '../harness/temp-dir.js';
import type { CommandResult } from '../utils/command-runner.js';
import { compileChecker, lintChecker, testsChecker } from './index.js';
import { resolveCompileCommand, resolveLintCommands, resolveTestsCommand } from './resolve-commands.js';

const tmp = createTempDirs();
afterEach(() => tmp.cleanup());

function repo(files: Record<string, string>): string {
  const dir = tmp.makeSync('resolve-commands-');
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  return dir;
}

const everyGuess = {
  'scripts/verify.sh': '',
  'scripts/verify.ps1': '',
  'package.json': JSON.stringify({ scripts: { build: 'b', test: 't', lint: 'l' } }),
  Makefile: 'all:\n',
  'tsconfig.json': '{}',
};
const config = (checks: Record<string, string>) => JSON.stringify({ version: 2, checks });

describe('declared checks precedence', () => {
  it('a declared command beats every file-based guess', async () => {
    const dir = repo({
      ...everyGuess,
      '.factory/config.json': config({ build: 'dotnet build', test: 'dotnet test', lint: 'dotnet format' }),
    });
    expect(await resolveCompileCommand({ worktree: dir })).toEqual({
      argv: ['dotnet', 'build'],
      source: '.factory/config.json',
    });
    expect(await resolveTestsCommand({ worktree: dir })).toEqual({
      runner: 'config',
      argv: ['dotnet', 'test'],
      label: 'checks.test',
      source: '.factory/config.json',
    });
    expect(await resolveLintCommands({ worktree: dir })).toEqual([
      { label: 'checks.lint', argv: ['dotnet', 'format'], source: '.factory/config.json' },
    ]);
  });

  it('an undeclared kind falls back to its file-based guess', async () => {
    const dir = repo({ ...everyGuess, '.factory/config.json': config({ test: 'dotnet test' }) });
    expect((await resolveCompileCommand({ worktree: dir }))?.source).toBe('package.json');
    expect((await resolveTestsCommand({ worktree: dir })).runner).toBe('config');
    expect((await resolveLintCommands({ worktree: dir })).map((c) => c.label)).toEqual(['lint', 'tsc']);
  });

  it('the checks seam beats the config file, and null means no declared commands', async () => {
    const dir = repo({ ...everyGuess, '.factory/config.json': config({ test: 'dotnet test' }) });
    expect((await resolveTestsCommand({ worktree: dir, checks: { test: 'go test ./...' } })).argv).toEqual([
      'go',
      'test',
      './...',
    ]);
    expect((await resolveTestsCommand({ worktree: dir, checks: null })).runner).toBe('verify');
  });

  it('names a YAML config file as the source', async () => {
    const dir = repo({ '.factory/config.yaml': 'version: 2\nchecks:\n  build: cargo build\n' });
    expect((await resolveCompileCommand({ worktree: dir }))?.source).toBe('.factory/config.yaml');
  });
});

describe('checkers run declared commands', () => {
  const ok = (argv: readonly string[]): CommandResult => ({
    command: argv,
    stdout: '',
    stderr: '',
    exitCode: 0,
    killed: false,
    timedOut: false,
    ok: true,
  });

  it('tests and compile run the declared argv', async () => {
    const dir = repo({ '.factory/config.json': config({ build: 'dotnet build', test: 'pwsh ./run-tests.ps1' }) });
    const ran: (readonly string[])[] = [];
    const runCommand = async (argv: readonly string[]) => (ran.push(argv), ok(argv));
    const ctx = { worktree: dir, specPath: join(dir, 'spec.md'), runCommand };
    expect(await testsChecker(ctx)).toMatchObject({ result: 'PASS', details: 'checks.test: OK' });
    expect(await compileChecker(ctx)).toMatchObject({ result: 'PASS', details: 'dotnet build: OK' });
    expect(ran).toEqual([
      ['pwsh', './run-tests.ps1'],
      ['dotnet', 'build'],
    ]);
  });

  it('an invalid config fails the lint checker instead of throwing', async () => {
    const dir = repo({ '.factory/config.json': config({ lint: 'a | b' }) });
    const out = await lintChecker({ worktree: dir, specPath: join(dir, 'spec.md') });
    expect(out.result).toBe('FAIL');
    expect(out.details).toContain('checks.lint');
  });

  it('the no-tests SKIP names checks.test', async () => {
    const dir = repo({});
    const out = await testsChecker({ worktree: dir, specPath: join(dir, 'spec.md') });
    expect(out).toMatchObject({ result: 'SKIP' });
    expect(out.details).toContain('checks.test');
  });
});
