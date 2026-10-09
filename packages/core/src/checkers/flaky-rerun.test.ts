import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommandResult } from '../utils/command-runner.js';
import {
  buildRerunPlan,
  RERUN_TIMEOUT_MS,
  type RerunPlan,
  rerunFailingTests,
  rerunTestsChecker,
} from './flaky-rerun.js';
import type { CheckerContext, TestsCommand, WorktreeProbe } from './index.js';

const npm: TestsCommand = { runner: 'npm', argv: ['npm', 'test'], label: 'npm test' };
const pkgWith = (test: string) => ({ scripts: { test } }) as never;

describe('buildRerunPlan', () => {
  it('targets vitest failures serially with an escaped pattern', () => {
    const details = ' FAIL  a.test.ts > suite > adds (1+1) 12ms\n × suite > b.c works';
    const plan = buildRerunPlan(npm, pkgWith('vitest run'), details);
    expect(plan).toEqual({
      mode: 'targeted',
      argv: ['npm', 'test', '--', '-t', 'adds \\(1\\+1\\)|b\\.c works', '--no-file-parallelism'],
      timeoutMs: RERUN_TIMEOUT_MS,
      tests: ['adds \\(1\\+1\\)', 'b\\.c works'],
    });
    expect(RERUN_TIMEOUT_MS).toBe(600_000);
  });

  it('uses --runInBand for jest', () => {
    const plan = buildRerunPlan(npm, pkgWith('jest --ci'), ' × s > one');
    expect(plan.argv).toEqual(['npm', 'test', '--', '-t', 'one', '--runInBand']);
  });

  it('falls back to full for unknown runner, null pkg, and zero names', () => {
    expect(buildRerunPlan(npm, pkgWith('node --test'), ' × one')).toMatchObject({
      mode: 'full',
      argv: ['npm', 'test'],
      tests: [],
    });
    expect(buildRerunPlan(npm, null, ' × one').mode).toBe('full');
    expect(buildRerunPlan(npm, pkgWith('vitest'), 'npm ERR! boom').mode).toBe('full');
  });

  it('dedupes names sharing a last segment', () => {
    const plan = buildRerunPlan(npm, pkgWith('vitest'), ' × a > same\n × b > same');
    expect(plan.tests).toEqual(['same']);
  });

  it('targets pytest node ids', () => {
    const cmd: TestsCommand = { runner: 'pytest', argv: ['python3', '-m', 'pytest'], label: 'pytest' };
    const plan = buildRerunPlan(cmd, null, 'pytest failed: FAILED tests/x.py::test_a - AssertionError');
    expect(plan.mode).toBe('targeted');
    expect(plan.argv).toEqual(['python3', '-m', 'pytest', 'tests/x.py::test_a']);
    expect(plan.tests).toEqual(['tests/x.py::test_a']);
  });

  it('falls back to full for pytest without node ids', () => {
    const cmd: TestsCommand = {
      runner: 'pytest',
      argv: ['python3', '-m', 'pytest', '.factory/tests'],
      label: 'pytest',
    };
    expect(buildRerunPlan(cmd, null, ' × vitest style').argv).toEqual(['python3', '-m', 'pytest', '.factory/tests']);
  });

  it('falls back to full for verify and none', () => {
    const verify: TestsCommand = {
      runner: 'verify',
      argv: ['bash', 'scripts/verify.sh', '--no-e2e'],
      label: 'verify.sh',
    };
    expect(buildRerunPlan(verify, null, ' × one')).toEqual({
      mode: 'full',
      argv: ['bash', 'scripts/verify.sh', '--no-e2e'],
      timeoutMs: 600_000,
      tests: [],
    });
    expect(buildRerunPlan({ runner: 'none', argv: [], label: '' }, null, '').argv).toEqual([]);
  });

  it('returns a copy of argv', () => {
    const plan = buildRerunPlan(npm, null, '');
    plan.argv.push('x');
    expect(npm.argv).toEqual(['npm', 'test']);
  });
});

describe('rerunFailingTests', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const tmp = async () => {
    const d = await mkdtemp(join(tmpdir(), 'flaky-rerun-'));
    dirs.push(d);
    return d;
  };
  const result = (over: Partial<CommandResult> = {}): CommandResult => ({
    command: ['npm', 'test'],
    stdout: 'out',
    stderr: '',
    exitCode: 0,
    killed: false,
    timedOut: false,
    ok: true,
    ...over,
  });
  const plan: RerunPlan = {
    mode: 'targeted',
    argv: ['npm', 'test', '--', '-t', 'adds'],
    timeoutMs: RERUN_TIMEOUT_MS,
    tests: ['adds'],
  };
  const ctxWith = (runCommand: CheckerContext['runCommand'], extra: Partial<CheckerContext> = {}): CheckerContext =>
    ({ worktree: '/wt', env: { A: '1' }, onPgid: () => {}, runCommand, ...extra }) as CheckerContext;

  it('reports passed and writes the log', async () => {
    const outputLogDir = await tmp();
    const run = vi.fn(async () => result());
    const ctx = ctxWith(run, { outputLogDir });
    const r = await rerunFailingTests({ ctx, plan });
    expect(r).toMatchObject({ verdict: 'passed', mode: 'targeted', tests: ['adds'] });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(plan.argv, {
      cwd: '/wt',
      timeoutMs: 600_000,
      env: ctx.env,
      onPgid: ctx.onPgid,
    });
    expect(r.logPath).toMatch(/flaky-rerun-tests\.log$/);
    expect(existsSync(r.logPath as string)).toBe(true);
  });

  it('reports reproduced on a failing exit', async () => {
    const run = vi.fn(async () => result({ exitCode: 1, ok: false }));
    expect((await rerunFailingTests({ ctx: ctxWith(run), plan })).verdict).toBe('reproduced');
  });

  it('reports not-run on timeout', async () => {
    const run = vi.fn(async () => result({ timedOut: true, ok: false, exitCode: null as never }));
    expect(await rerunFailingTests({ ctx: ctxWith(run), plan })).toMatchObject({
      verdict: 'not-run',
      reason: 'timed out after 600s',
    });
  });

  it('reports not-run without running when argv is empty', async () => {
    const run = vi.fn(async () => result());
    const r = await rerunFailingTests({ ctx: ctxWith(run), plan: { ...plan, mode: 'full', argv: [], tests: [] } });
    expect(r).toMatchObject({ verdict: 'not-run', reason: 'no tests command' });
    expect(run).not.toHaveBeenCalled();
  });

  it('reports not-run when the command throws', async () => {
    const err = vi.fn(async () => {
      throw new Error('spawn ENOENT');
    });
    expect(await rerunFailingTests({ ctx: ctxWith(err), plan })).toMatchObject({
      verdict: 'not-run',
      reason: expect.stringContaining('spawn ENOENT'),
    });
    const str = vi.fn(async () => {
      throw 'boom';
    });
    expect((await rerunFailingTests({ ctx: ctxWith(str), plan })).reason).toBe('boom');
  });

  it('has no logPath without outputLogDir', async () => {
    const run = vi.fn(async () => result());
    expect((await rerunFailingTests({ ctx: ctxWith(run), plan })).logPath).toBeUndefined();
  });
});

describe('rerunTestsChecker', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const worktree = async () => {
    const d = await mkdtemp(join(tmpdir(), 'flaky-rerun-wt-'));
    dirs.push(d);
    await writeFile(join(d, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    return d;
  };
  const ok = {
    command: ['npm', 'test'],
    stdout: '',
    stderr: '',
    exitCode: 0,
    killed: false,
    timedOut: false,
    ok: true,
  };

  it('plans a targeted re-run from the failing details', async () => {
    const run = vi.fn(async (_argv: readonly string[]) => ok);
    const ctx: CheckerContext = { worktree: await worktree(), specPath: 'spec.md', runCommand: run };
    const r = await rerunTestsChecker(ctx, ' × suite > adds');
    expect(run.mock.calls[0]?.[0]).toEqual(['npm', 'test', '--', '-t', 'adds', '--no-file-parallelism']);
    expect(r.verdict).toBe('passed');
  });

  it('returns not-run when planning throws', async () => {
    const run = vi.fn(async () => ok);
    const ctx: CheckerContext = {
      worktree: await worktree(),
      specPath: 'spec.md',
      runCommand: run,
      probe: { packageJson: { status: 'unreadable', error: new Error('bad json') } } as WorktreeProbe,
    };
    expect(await rerunTestsChecker(ctx, ' × suite > adds')).toMatchObject({ verdict: 'not-run', reason: 'bad json' });
    expect(run).not.toHaveBeenCalled();
  });
});
