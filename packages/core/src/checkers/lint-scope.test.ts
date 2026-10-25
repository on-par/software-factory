// src/checkers/lint-scope.test.ts — lint scoping: profiles, file lists, findings, diff and merge-base worktree (#1898)

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { runCommand } from '../utils/command-runner.js';
import type { LintCommand } from './resolve-commands.js';
import {
  extractLintFindings,
  formatLintFindings,
  lintToolProfile,
  resolveLintDiff,
  scopeLintCommand,
  withMergeBaseWorktree,
} from './lint-scope.js';

const declared = (...argv: string[]): LintCommand => ({ label: 'checks.lint', argv });

describe('lintToolProfile', () => {
  it('maps launchers, two-word tools and labels; unknown binaries give null', () => {
    expect(lintToolProfile(declared('npx', 'eslint', '.'))?.tool).toBe('eslint');
    expect(lintToolProfile(declared('npx', '--no-install', 'prettier', '--check', '.'))?.tool).toBe('prettier');
    expect(lintToolProfile(declared('uv', 'run', 'ruff', 'check', '.'))?.tool).toBe('ruff check');
    expect(lintToolProfile(declared('python3', '-m', 'black', '.'))?.tool).toBe('black');
    expect(lintToolProfile(declared('dotnet', 'format', 'A.sln', '--verify-no-changes'))?.tool).toBe('dotnet format');
    expect(lintToolProfile({ label: 'lint', argv: ['npm', 'run', 'lint'] })?.tool).toBe('npm run lint');
    expect(lintToolProfile({ label: 'tsc', argv: ['npx', 'tsc', '--noEmit'] })?.tool).toBe('tsc');
    expect(lintToolProfile(declared('stylelint', '.'))).toBeNull();
    expect(lintToolProfile(declared('ruff', 'unknown'))).toBeNull();
    expect(lintToolProfile(declared())).toBeNull();
  });
});

describe('scopeLintCommand', () => {
  it('replaces a bare dot with the changed files that match', () => {
    const s = scopeLintCommand(declared('eslint', '.'), ['src/a.ts', 'README.md']);
    expect(s).toEqual({ kind: 'files', argv: ['eslint', 'src/a.ts'], files: ['src/a.ts'] });
  });
  it('keeps flags and launcher prefix when replacing the dot', () => {
    const s = scopeLintCommand(declared('npx', 'ruff', 'check', '--no-cache', '.'), ['a.py']);
    expect(s).toMatchObject({ kind: 'files', argv: ['npx', 'ruff', 'check', '--no-cache', 'a.py'] });
  });
  it('skips with a reason naming the file types on a docs-only change', () => {
    const s = scopeLintCommand(declared('eslint', '.'), ['docs/x.md']);
    expect(s).toMatchObject({ kind: 'skip' });
    expect((s as { reason: string }).reason).toBe(
      'checks.lint: skipped — no changed file matches eslint file types (.js, .jsx, .mjs, .cjs, .ts, .tsx, .mts, .cts, .vue)',
    );
  });
  it('runs whole for other operands and for a changed tool config', () => {
    expect(scopeLintCommand(declared('eslint', 'src'), ['src/a.ts']).kind).toBe('whole');
    expect(scopeLintCommand(declared('ruff', 'check', '--select', 'E', '.'), ['a.py']).kind).toBe('whole');
    expect(scopeLintCommand(declared('eslint', '.'), ['eslint.config.js']).kind).toBe('whole');
  });
  it('appends --include for dotnet format, unless one is present', () => {
    const argv = ['dotnet', 'format', 'A.sln', '--verify-no-changes'];
    expect(scopeLintCommand(declared(...argv), ['a.cs'])).toMatchObject({
      kind: 'files',
      argv: [...argv, '--include', 'a.cs'],
    });
    expect(scopeLintCommand(declared(...argv, '--include', 'x.cs'), ['a.cs']).kind).toBe('whole');
  });
  it('never runs write-mode commands', () => {
    const fix = scopeLintCommand(declared('eslint', '.', '--fix'), ['a.ts']);
    expect(fix).toMatchObject({ kind: 'write-mode' });
    expect((fix as { reason: string }).reason).toContain('write mode');
    expect((fix as { reason: string }).reason).toContain('`eslint .`');
    expect(scopeLintCommand(declared('prettier', '--write', '.'), ['a.ts']).kind).toBe('write-mode');
    expect(scopeLintCommand(declared('prettier', '--check', '.'), ['a.ts']).kind).toBe('files');
    expect(scopeLintCommand(declared('black', '.'), ['a.py']).kind).toBe('write-mode');
    expect(scopeLintCommand(declared('cargo', 'fmt'), ['a.rs']).kind).toBe('write-mode');
    expect(scopeLintCommand(declared('dotnet', 'format', 'A.sln'), ['a.cs']).kind).toBe('write-mode');
    expect(scopeLintCommand(declared('ruff', 'format', '--check', '.'), ['a.py']).kind).toBe('files');
  });
  it('runs file-less tools whole and skips on unrelated changes', () => {
    const tsc: LintCommand = { label: 'tsc', argv: ['npx', 'tsc', '--noEmit'] };
    expect(scopeLintCommand(tsc, ['src/a.ts']).kind).toBe('whole');
    expect(scopeLintCommand(tsc, ['logo.png']).kind).toBe('skip');
    expect(scopeLintCommand(tsc, ['tsconfig.build.json']).kind).toBe('whole');
    const docs = scopeLintCommand({ label: 'lint', argv: ['npm', 'run', 'lint'] }, ['README.md', 'a.txt']);
    expect(docs).toMatchObject({ kind: 'skip' });
    expect((docs as { reason: string }).reason).toContain('only docs changed');
    expect(scopeLintCommand({ label: 'lint', argv: ['npm', 'run', 'lint'] }, ['a.py']).kind).toBe('whole');
  });
  it('runs whole over 200 matching files and for unknown tools', () => {
    const many = Array.from({ length: 201 }, (_, i) => `f${i}.ts`);
    expect(scopeLintCommand(declared('eslint', '.'), many).kind).toBe('whole');
    expect(scopeLintCommand(declared('stylelint', '.'), ['a.css'])).toEqual({
      kind: 'whole',
      argv: ['stylelint', '.'],
      profile: null,
    });
  });
});

describe('extractLintFindings', () => {
  it('parses tsc, ruff, dotnet, eslint stylish and golangci output', () => {
    expect(extractLintFindings("src/a.ts(3,7): error TS2322: Type 'x' is not assignable")).toEqual([
      { file: 'src/a.ts', line: 3, rule: 'TS2322' },
    ]);
    expect(extractLintFindings('a.py:1:8: F401 `os` imported but unused')).toEqual([
      { file: 'a.py', line: 1, rule: 'F401' },
    ]);
    expect(
      extractLintFindings('/abs/wt/A.cs(10,5): error WHITESPACE: Fix whitespace. [/abs/wt/A.csproj]', '/abs/wt'),
    ).toEqual([{ file: 'A.cs', line: 10, rule: 'WHITESPACE' }]);
    const eslint =
      "/r/src/b.ts\n  4:10  error  'x' is defined but never used  no-unused-vars\n  9:1  warning  Missing semi  semi\n";
    expect(extractLintFindings(eslint, '/r')).toEqual([
      { file: 'src/b.ts', line: 4, rule: 'no-unused-vars' },
      { file: 'src/b.ts', line: 9, rule: 'semi' },
    ]);
    expect(extractLintFindings('.\\main.go:7:2: Error return value is not checked (errcheck)')).toEqual([
      { file: 'main.go', line: 7, rule: 'errcheck' },
    ]);
  });
  it('dedupes, caps at 50 and returns [] for garbage', () => {
    expect(extractLintFindings('hello\nworld')).toEqual([]);
    expect(extractLintFindings('a.py:1:1: F401 x\na.py:1:1: F401 x')).toHaveLength(1);
    const lots = Array.from({ length: 80 }, (_, i) => `a.py:${i + 1}:1: F401 x`).join('\n');
    expect(extractLintFindings(lots)).toHaveLength(50);
  });
  it('renders at most 10 findings with a remainder count', () => {
    const f = Array.from({ length: 12 }, (_, i) => ({ file: 'a.py', line: i + 1, rule: 'F401' }));
    expect(formatLintFindings(f)).toMatch(/^a\.py:1 F401; .*a\.py:10 F401 \(\+2 more\)$/);
    expect(formatLintFindings([])).toBe('');
  });
});

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });

/** A repo with origin/main at the first commit and one later change set. */
async function makeRepo(): Promise<string> {
  const dir = await dirs.make('lint-scope-');
  git(dir, 'init', '-q', '-b', 'main');
  await writeFile(join(dir, 'old.ts'), 'export const a = 1;\n');
  await writeFile(join(dir, 'gone.ts'), 'x\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return dir;
}

describe('resolveLintDiff', () => {
  it('lists committed, uncommitted and untracked paths that still exist, plus the merge base', async () => {
    const dir = await makeRepo();
    const base = git(dir, 'rev-parse', 'HEAD').trim();
    await writeFile(join(dir, 'new.ts'), 'n\n');
    git(dir, 'add', '.');
    git(dir, 'rm', '-q', 'gone.ts');
    git(dir, 'commit', '-q', '-m', 'change');
    await writeFile(join(dir, 'old.ts'), 'export const a = 2;\n');
    await writeFile(join(dir, 'untracked.ts'), 'u\n');
    const diff = await resolveLintDiff({ worktree: dir });
    expect(diff).toEqual({ baseRef: 'origin/main', mergeBase: base, changed: ['new.ts', 'old.ts', 'untracked.ts'] });
  });
  it('uses parentBaseRef without fallback, and diffBase when no origin ref exists', async () => {
    const dir = await makeRepo();
    expect(await resolveLintDiff({ worktree: dir, parentBaseRef: 'no-such-ref' })).toEqual({
      unavailable: 'no base ref resolves',
    });
    git(dir, 'update-ref', '-d', 'refs/remotes/origin/main');
    const head = git(dir, 'rev-parse', 'HEAD').trim();
    expect(await resolveLintDiff({ worktree: dir, diffBase: head })).toMatchObject({ baseRef: head, changed: [] });
  });
  it('is unavailable outside a git checkout', async () => {
    const dir = await dirs.make('lint-scope-nogit-');
    expect(await resolveLintDiff({ worktree: dir })).toHaveProperty('unavailable');
  });
});

describe('withMergeBaseWorktree', () => {
  it('runs fn at the merge base and removes the worktree afterwards', async () => {
    const dir = await makeRepo();
    const base = git(dir, 'rev-parse', 'HEAD').trim();
    await writeFile(join(dir, 'old.ts'), 'export const a = 2;\n');
    git(dir, 'commit', '-q', '-am', 'edit');
    let seenDir = '';
    const res = await withMergeBaseWorktree(
      { laneWorktree: dir, mergeBase: base, run: (argv, options) => runCommand(argv, options) },
      async (wt) => {
        seenDir = wt;
        return readFile(join(wt, 'old.ts'), 'utf8');
      },
    );
    expect(res).toEqual({ ok: true, value: 'export const a = 1;\n' });
    expect(existsSync(seenDir)).toBe(false);
    expect(git(dir, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });
  it('reports a failed worktree add, a failed install and a throwing fn without throwing', async () => {
    const dir = await makeRepo();
    const base = git(dir, 'rev-parse', 'HEAD').trim();
    const bad = await withMergeBaseWorktree(
      { laneWorktree: dir, mergeBase: 'deadbeef', run: (argv, options) => runCommand(argv, options) },
      async () => 1,
    );
    expect(bad).toMatchObject({ ok: false });
    const thrown = await withMergeBaseWorktree(
      { laneWorktree: dir, mergeBase: base, run: (argv, options) => runCommand(argv, options) },
      async () => {
        throw new Error('boom');
      },
    );
    expect(thrown).toEqual({ ok: false, error: 'merge-base run failed: boom' });
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{}');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'pkg');
    const head = git(dir, 'rev-parse', 'HEAD').trim();
    const failedInstall = await withMergeBaseWorktree(
      {
        laneWorktree: dir,
        mergeBase: head,
        run: (argv, options) =>
          argv[0] === 'npm'
            ? Promise.resolve({
                command: argv,
                stdout: '',
                stderr: 'nope',
                exitCode: 1,
                killed: false,
                timedOut: false,
                ok: false,
              })
            : runCommand(argv, options),
      },
      async () => 1,
    );
    expect(failedInstall).toMatchObject({ ok: false, error: expect.stringContaining('dependency install failed') });
    expect(git(dir, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
    await rm(join(dir, 'sub'), { recursive: true });
  });
});
