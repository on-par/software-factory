import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommandResult } from '../utils/command-runner.js';
import { checkBaseHealth, type BaseHealthOptions } from './base-health.js';
import { compileChecker, type CheckerContext } from './index.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeWorktree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'compile-timeout-'));
  dirs.push(dir);
  await mkdir(dir, { recursive: true });
  for (const [path, contents] of Object.entries(files)) await writeFile(join(dir, path), contents);
  return dir;
}

const BUILD_PKG = JSON.stringify({ scripts: { build: 'x' } });

/** Fake runner simulating a 3s build: times out when given less than 3s, else succeeds. */
function slowRunner() {
  return vi.fn(async (argv: string[], o: { timeoutMs?: number }): Promise<CommandResult> => {
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
  });
}

function ctxFor(worktree: string, run: ReturnType<typeof slowRunner>, extra: Partial<CheckerContext> = {}) {
  return { worktree, specPath: join(worktree, 'none.md'), runCommand: run as never, ...extra };
}

describe('compileChecker timeout (#3185)', () => {
  it('compileChecker: a build slower than compileTimeoutSeconds FAILs naming timeouts.compile_seconds and FACTORY_COMPILE_TIMEOUT', async () => {
    const worktree = await makeWorktree({ 'package.json': BUILD_PKG });
    const run = slowRunner();
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
    const run = slowRunner();
    await compileChecker(ctxFor(worktree, run));
    expect(run.mock.calls[0][1].timeoutMs).toBe(120_000);
  });

  it('passes the configured timeout to make', async () => {
    const worktree = await makeWorktree({ Makefile: 'all:\n\ttrue\n' });
    const run = slowRunner();
    await compileChecker(ctxFor(worktree, run, { compileTimeoutSeconds: 600 }));
    expect(run.mock.calls[0][0]).toEqual(['make']);
    expect(run.mock.calls[0][1].timeoutMs).toBe(600_000);
  });

  it('passes the configured timeout to cargo build', async () => {
    const worktree = await makeWorktree({ 'Cargo.toml': '[package]\nname = "x"\n' });
    const run = slowRunner();
    await compileChecker(ctxFor(worktree, run, { compileTimeoutSeconds: 600 }));
    expect(run.mock.calls[0][0]).toEqual(['cargo', 'build']);
    expect(run.mock.calls[0][1].timeoutMs).toBe(600_000);
  });
});

describe('checkBaseHealth compile timeout (#3185)', () => {
  function cmd(stdout: string): CommandResult {
    return { command: [], stdout, stderr: '', exitCode: 0, killed: false, timedOut: false, ok: true };
  }

  /** Runs the real compileChecker on base against the fake 3s build. */
  async function baseCompile(compileTimeoutSeconds: number) {
    const fixture = await makeWorktree({ 'package.json': BUILD_PKG });
    const run = slowRunner();
    let compile: Awaited<ReturnType<typeof compileChecker>> | undefined;
    const baselineDeps = {
      runCommand: vi.fn(async () => cmd('')),
      runCheckers: (async (ctx: CheckerContext) => {
        compile = await compileChecker({ ...ctx, worktree: fixture, runCommand: run as never });
        return { failures: 0, passes: 1, skips: 0, total: 1, results: [compile] };
      }) as never,
      makeTempDir: () => mkdtemp(join(fixture, 'p-')),
    };
    const o: BaseHealthOptions = {
      worktree: '/tmp/wt',
      constitution: null,
      router: {} as never,
      env: {},
      log: vi.fn(),
      compileTimeoutSeconds,
      deps: {
        memo: new Map(),
        runCommand: vi.fn(async () => cmd(`${'a'.repeat(40)}\n`)),
        baselineDeps,
      },
    };
    const res = await checkBaseHealth(o);
    return { res, compile, timeoutMs: run.mock.calls[0]?.[1].timeoutMs };
  }

  it('runs the base build with compileTimeoutSeconds 10 and is green', async () => {
    const { res, compile, timeoutMs } = await baseCompile(10);
    expect(timeoutMs).toBe(10_000);
    expect(compile?.result).toBe('PASS');
    expect(res.kind).toBe('green');
  });

  it('a 1s compile timeout against the 3s build fails compile on base', async () => {
    const { compile, timeoutMs } = await baseCompile(1);
    expect(timeoutMs).toBe(1000);
    expect(compile?.result).toBe('FAIL');
    expect(compile?.details).toContain('FACTORY_COMPILE_TIMEOUT');
  });
});
