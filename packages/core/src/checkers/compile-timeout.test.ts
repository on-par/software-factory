import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import type { CommandResult } from '../utils/command-runner.js';
import { compileChecker, resolveCompileCommand, type CheckerContext } from './index.js';

const tmp = createTempDirs();

afterEach(async () => {
  await tmp.cleanup();
});

async function makeWorktree(files: Record<string, string>): Promise<string> {
  const dir = await tmp.make('compile-timeout-');
  await mkdir(dir, { recursive: true });
  for (const [path, contents] of Object.entries(files)) await writeFile(join(dir, path), contents);
  return dir;
}

const BUILD_PKG = JSON.stringify({ scripts: { build: 'x' } });

function threeSecondBuildRunner() {
  const calls: { argv: string[]; timeoutMs?: number }[] = [];
  const run = async (argv: string[], o: { timeoutMs?: number }): Promise<CommandResult> => {
    calls.push({ argv, timeoutMs: o.timeoutMs });
    const timedOut = (o.timeoutMs ?? 0) < 3000;
    return {
      command: argv,
      stdout: '',
      stderr: '',
      exitCode: timedOut ? -1 : 0,
      killed: timedOut,
      timedOut,
      ok: !timedOut,
    };
  };
  return { run, calls };
}

function ctxFor(
  worktree: string,
  run: ReturnType<typeof threeSecondBuildRunner>['run'],
  extra: Partial<CheckerContext> = {},
) {
  return { worktree, specPath: join(worktree, 'none.md'), runCommand: run as never, ...extra };
}

describe('compileChecker timeout (#3185)', () => {
  it('compileChecker: a build slower than compileTimeoutSeconds FAILs naming timeouts.compile_seconds and FACTORY_COMPILE_TIMEOUT', async () => {
    const worktree = await makeWorktree({ 'package.json': BUILD_PKG });
    const { run } = threeSecondBuildRunner();
    const result = await compileChecker(ctxFor(worktree, run, { compileTimeoutSeconds: 1 }));
    expect(result.result).toBe('FAIL');
    expect(result.details).toContain('timed out after 1s');
    expect(result.details).toContain('timeouts.compile_seconds');
    expect(result.details).toContain('FACTORY_COMPILE_TIMEOUT');
    const ok = await compileChecker(ctxFor(worktree, run, { compileTimeoutSeconds: 10 }));
    expect(ok.result).toBe('PASS');
  });

  it('defaults to 120s for npm run build', async () => {
    const worktree = await makeWorktree({ 'package.json': BUILD_PKG });
    const { run, calls } = threeSecondBuildRunner();
    await compileChecker(ctxFor(worktree, run));
    expect(calls[0].timeoutMs).toBe(120_000);
  });

  it('passes the configured timeout to make', async () => {
    const worktree = await makeWorktree({ Makefile: 'all:\n\ttrue\n' });
    const { run, calls } = threeSecondBuildRunner();
    await compileChecker(ctxFor(worktree, run, { compileTimeoutSeconds: 600 }));
    expect(calls[0]).toEqual({ argv: ['make'], timeoutMs: 600_000 });
  });

  it('passes the configured timeout to cargo build', async () => {
    const worktree = await makeWorktree({ 'Cargo.toml': '[package]\nname = "x"\n' });
    const { run, calls } = threeSecondBuildRunner();
    await compileChecker(ctxFor(worktree, run, { compileTimeoutSeconds: 600 }));
    expect(calls[0]).toEqual({ argv: ['cargo', 'build'], timeoutMs: 600_000 });
  });
});

describe('resolveCompileCommand (#3473)', () => {
  it('prefers package.json build, then Makefile, then Cargo.toml, else null', async () => {
    const both = await makeWorktree({ 'package.json': BUILD_PKG, Makefile: '', 'Cargo.toml': '' });
    expect(await resolveCompileCommand({ worktree: both })).toEqual({
      argv: ['npm', 'run', 'build'],
      source: 'package.json',
    });
    const make = await makeWorktree({ Makefile: '', 'Cargo.toml': '' });
    expect(await resolveCompileCommand({ worktree: make })).toEqual({ argv: ['make'], source: 'Makefile' });
    const cargo = await makeWorktree({ 'Cargo.toml': '' });
    expect(await resolveCompileCommand({ worktree: cargo })).toEqual({
      argv: ['cargo', 'build'],
      source: 'Cargo.toml',
    });
    expect(await resolveCompileCommand({ worktree: await makeWorktree({}) })).toBeNull();
  });
});
