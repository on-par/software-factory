// src/checkers/lint-new-findings.test.ts — lintChecker fails only on findings the change adds (#1898)

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { type CommandResult, type RunCommandOptions, runCommand } from '../utils/command-runner.js';
import { type CheckerContext, lintChecker } from './index.js';

const dirs = createTempDirs();
afterEach(() => dirs.cleanup());

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });

async function put(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
}

/** A repo whose origin/main holds `base`; `change` is then committed on top. */
async function makeRepo(base: Record<string, string>, change: Record<string, string>): Promise<string> {
  const dir = await dirs.make('lint-new-findings-');
  git(dir, 'init', '-q', '-b', 'main');
  await put(dir, base);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  await put(dir, change);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'change');
  return dir;
}

interface ToolCall {
  argv: readonly string[];
  cwd: string | undefined;
}

function result(argv: readonly string[], exitCode: number, stdout = ''): CommandResult {
  return { command: argv, stdout, stderr: '', exitCode, killed: false, timedOut: false, ok: exitCode === 0 };
}

/** Real git; every other command goes to `tool` and is recorded. */
function fakeRunner(tool: (argv: readonly string[], cwd: string | undefined) => CommandResult) {
  const calls: ToolCall[] = [];
  const run = async (argv: readonly string[], options?: RunCommandOptions): Promise<CommandResult> => {
    if (argv[0] === 'git') return runCommand(argv, options ?? {});
    calls.push({ argv, cwd: options?.cwd });
    return tool(argv, options?.cwd);
  };
  return { run, calls };
}

const ctxFor = (worktree: string, lint: string, run: CheckerContext['runCommand']): CheckerContext => ({
  worktree,
  specPath: join(worktree, 'spec.md'),
  checks: { lint },
  runCommand: run,
});

describe('lintChecker new findings', () => {
  it('FAILs on a violation in a changed file and names file, line and rule', async () => {
    const dir = await makeRepo({ 'ok.py': 'x = 1\n' }, { 'bad.py': 'import os\n' });
    const { run, calls } = fakeRunner((argv) => result(argv, 1, 'bad.py:2:1: F401 unused import\n'));
    const out = await lintChecker(ctxFor(dir, 'ruff check .', run));
    expect(out.result).toBe('FAIL');
    expect(out.details).toContain('bad.py:2 F401');
    expect(calls.map((c) => c.argv)).toEqual([['ruff', 'check', 'bad.py']]);
  });

  it('PASSes with a pre-existing warning when only unchanged files violate', async () => {
    const dir = await makeRepo({ 'src/old.rs': 'x\n' }, { 'src/new.rs': 'y\n' });
    const { run } = fakeRunner((argv) =>
      result(argv, 1, 'src/old.rs:5:1: needless return (clippy::needless_return)\n'),
    );
    const out = await lintChecker(ctxFor(dir, 'cargo clippy', run));
    expect(out.result).toBe('PASS');
    expect(out.details).toContain('warning: pre-existing');
    expect(out.details).toContain('src/old.rs:5');
  });

  it('runs the declared dotnet format command unchanged plus --include of the changed files, from the worktree that holds .editorconfig', async () => {
    const dir = await makeRepo(
      { '.editorconfig': 'root = true\n', 'A.sln': '', 'Program.cs': 'a\n' },
      { 'Program.cs': 'b\n' },
    );
    const { run, calls } = fakeRunner((argv) => result(argv, 0));
    const out = await lintChecker(ctxFor(dir, 'dotnet format A.sln --verify-no-changes', run));
    expect(out.result).toBe('PASS');
    expect(calls).toEqual([
      { argv: ['dotnet', 'format', 'A.sln', '--verify-no-changes', '--include', 'Program.cs'], cwd: dir },
    ]);
  });

  it('skips every code linter with a reason on a docs-only change', async () => {
    const dir = await makeRepo(
      { 'package.json': '{"scripts":{"lint":"x"}}', 'tsconfig.json': '{}', 'a.ts': 'a\n' },
      { 'docs/x.md': '# hi\n' },
    );
    const { run, calls } = fakeRunner((argv) => result(argv, 1));
    const out = await lintChecker({ ...ctxFor(dir, '', run), checks: null });
    expect(out.result).toBe('SKIP');
    expect(out.details).toContain('lint: skipped — no changed file matches');
    expect(out.details).toContain('tsc: skipped');
    expect(calls).toEqual([]);
  });

  it('never runs a write-mode command and leaves the worktree unmodified', async () => {
    const dir = await makeRepo({ 'a.ts': 'a\n' }, { 'b.ts': 'b\n' });
    const before = git(dir, 'status', '--porcelain');
    const { run, calls } = fakeRunner((argv) => result(argv, 1));
    const out = await lintChecker(ctxFor(dir, 'eslint . --fix', run));
    expect(calls).toEqual([]);
    expect(out.result).toBe('SKIP');
    expect(out.details).toContain('write mode');
    expect(out.details).toContain('eslint .');
    expect(git(dir, 'status', '--porcelain')).toBe(before);
  });

  it('returns SKIP when no lint commands resolve', async () => {
    const dir = await makeRepo({ 'a.txt': 'a\n' }, { 'b.txt': 'b\n' });
    const out = await lintChecker({ ...ctxFor(dir, '', fakeRunner((a) => result(a, 0)).run), checks: null });
    expect(out.result).toBe('SKIP');
    expect(out.details).toContain('no linting configured');
  });

  it('FAILs without a base run when the whole-repo command times out', async () => {
    const dir = await makeRepo({ 'a.go': 'a\n' }, { 'b.go': 'b\n' });
    const { run, calls } = fakeRunner((argv) => ({ ...result(argv, -1), timedOut: true, killed: true }));
    const out = await lintChecker(ctxFor(dir, 'go vet ./...', run));
    expect(out.result).toBe('FAIL');
    expect(calls).toHaveLength(1);
  });

  it('treats a whole-repo failure on an empty diff as pre-existing without a base run', async () => {
    const dir = await makeRepo({ 'a.go': 'a\n' }, {});
    const { run, calls } = fakeRunner((argv) => result(argv, 1, 'a.go:1:1: bad (govet)\n'));
    const out = await lintChecker(ctxFor(dir, 'stylelint .', run));
    expect(out.result).toBe('PASS');
    expect(out.details).toContain('warning: pre-existing');
    expect(calls).toHaveLength(1);
  });
});

describe('lintChecker merge-base fallback', () => {
  it('FAILs when the merge base passes and HEAD fails; warns when both fail', async () => {
    const dir = await makeRepo({ 'a.go': 'a\n' }, { 'b.go': 'b\n' });
    const vetOutput = 'b.go:3:1: bad thing (govet)\n';

    const headOnly = fakeRunner((argv, cwd) => (cwd === dir ? result(argv, 1, vetOutput) : result(argv, 0)));
    const fail = await lintChecker(ctxFor(dir, 'go vet ./...', headOnly.run));
    expect(fail.result).toBe('FAIL');
    expect(fail.details).toContain('merge base');
    expect(fail.details).toContain('passes');
    expect(fail.details).toContain('b.go:3 govet');
    expect(headOnly.calls[1]?.cwd).not.toBe(dir);

    const both = fakeRunner((argv) => result(argv, 1, vetOutput));
    const warn = await lintChecker(ctxFor(dir, 'go vet ./...', both.run));
    expect(warn.result).toBe('PASS');
    expect(warn.details).toContain('warning: pre-existing');

    const run = async (argv: readonly string[], options?: RunCommandOptions): Promise<CommandResult> =>
      argv[0] === 'git' && argv[1] === 'worktree' && argv[2] === 'add'
        ? result(argv, 128)
        : headOnly.run(argv, options);
    const inconclusive = await lintChecker(ctxFor(dir, 'go vet ./...', run));
    expect(inconclusive.result).toBe('FAIL');
    expect(inconclusive.details).toContain('inconclusive');
  });

  it('keeps the whole-repo verdict when the worktree is not a git repo', async () => {
    const dir = await dirs.make('lint-nogit-');
    const { run } = fakeRunner((argv) => result(argv, 1, 'boom\n'));
    const out = await lintChecker(ctxFor(dir, 'go vet ./...', run));
    expect(out.result).toBe('FAIL');
    expect(out.details).toContain('changed files unknown');
  });
});
