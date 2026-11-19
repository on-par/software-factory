import { workKeyFromIssue } from '../work/work-key.js';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import type { BaselineReport } from '../checkers/baseline.js';
import { compileChecker, summarizeCheckerOutputs, testsChecker, type CheckerContext } from '../checkers/index.js';
import type { TestsAffectedConfig } from '../config/tests-section.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import { makeStubModelsConfig, makeStubRoutesConfig } from '../test-support/index.js';
import { cmdResult } from '../test-support/visual-proof-test-helpers.js';
import type { CommandResult } from '../utils/command-runner.js';
import { checkPhase } from './check.js';

const tempDirs = createTempDirs();
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(`${d}.spec.md`, { force: true })));
  await tempDirs.cleanup();
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

async function makeAffectedRepo(files = ['src/my widget.ts']): Promise<{ worktree: string; base: string }> {
  const worktree = await tempDirs.make('check-affected-');
  dirs.push(worktree);
  git(worktree, 'init', '-q');
  git(worktree, 'config', 'user.email', 't@t');
  git(worktree, 'config', 'user.name', 't');
  await writeFile(join(worktree, 'README.md'), 'x');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-qm', 'base');
  const base = git(worktree, 'rev-parse', 'HEAD');
  for (const f of files) {
    await mkdir(join(worktree, f, '..'), { recursive: true });
    await writeFile(join(worktree, f), 'export {};');
  }
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-qm', 'change');
  await writeFile(`${worktree}.spec.md`, '# spec');
  return { worktree, base };
}

const res = (ok: boolean, stdout: string): CommandResult => cmdResult({ ok, stdout, exitCode: ok ? 0 : 1 });
const FULL_FAIL = res(false, ' FAIL  src/a.test.ts > adds\nAssertionError');
const AFFECTED_PASS = res(true, ' Tests  1 passed (1)');

async function run(opts: {
  results: CommandResult[];
  files?: string[];
  affected?: boolean;
  maxReworkRounds?: number;
  cfg?: Partial<TestsAffectedConfig>;
  compile?: boolean;
  noDiffBase?: boolean;
  noChecks?: true;
}) {
  const { worktree, base } = await makeAffectedRepo(opts.files);
  const stub = new StubModelExecutor({ defaultOutput: 'rework complete' });
  const router = new ModelRouter(makeStubModelsConfig(), makeStubRoutesConfig(), false, stub);
  const argvs: string[][] = [];
  const logs: Array<[string, string]> = [];
  const fakeRun = async (argv: readonly string[]) => {
    argvs.push([...argv]);
    return opts.results[argvs.length - 1] ?? FULL_FAIL;
  };
  const result = await checkPhase({
    issue: workKeyFromIssue(3260),
    worktree,
    specPath: `${worktree}.spec.md`,
    router,
    constitution: null,
    maxReworkRounds: opts.maxReworkRounds ?? 3,
    diffBase: opts.noDiffBase ? undefined : base,
    log: (type, msg) => logs.push([type, msg]),
    testsAffected: opts.affected === false ? null : { command: 'npx vitest related --run {files}', ...opts.cfg },
    requiredChecksVerdict: async () => ({ green: true, reason: 'ok', noCodeHealthChecks: opts.noChecks }),
    runBaseline: async (o) => ({ baseSha: o.baseSha, checkers: [] }) as BaselineReport,
    runCommand: async () => FULL_FAIL,
    runCheckers: async (ctx: CheckerContext) => {
      ctx.runCommand = fakeRun;
      ctx.checks = { test: 'npm test', ...(opts.compile ? { build: 'npm run build' } : {}) };
      const compile = opts.compile ? [await compileChecker(ctx)] : [];
      return summarizeCheckerOutputs([...compile, await testsChecker(ctx)]);
    },
  });
  return { result, argvs, logs, stub };
}

const FULL = ['npm', 'test'];
const AFFECTED = ['npx', 'vitest', 'related', '--run', 'src/my widget.ts'];

describe('checkPhase tests.affected (#3260)', () => {
  it('keeps reworking when the final full pass fails', async () => {
    const { result, argvs } = await run({
      results: [FULL_FAIL, AFFECTED_PASS, FULL_FAIL, AFFECTED_PASS, res(true, '')],
    });
    expect(argvs).toEqual([FULL, AFFECTED, FULL, AFFECTED, FULL]);
    expect(result.passed).toBe(true);
    expect(result.reworkRounds).toBe(2);
  });

  it('is not passed when the final full pass keeps failing at the round cap', async () => {
    const { result } = await run({ results: [FULL_FAIL, AFFECTED_PASS, FULL_FAIL], maxReworkRounds: 1 });
    expect(result.passed).toBe(false);
  });

  it('runs the full suite and names the trigger when a trigger file changed', async () => {
    const { argvs, logs, stub } = await run({
      files: ['src/a.ts', 'pnpm-lock.yaml'],
      results: [FULL_FAIL, res(true, ''), res(true, '')],
      maxReworkRounds: 1,
    });
    expect(argvs).toEqual([FULL, FULL]);
    expect(stub.calls[0]!.prompt).toContain('fell back to the full suite: trigger — pnpm-lock.yaml');
    expect(logs.some(([t, m]) => t === 'affected_tests' && m.includes('trigger (pnpm-lock.yaml)'))).toBe(true);
  });

  it('without tests.affected the argv sequence and prompt are unchanged and nothing is logged', async () => {
    const { argvs, logs, stub } = await run({ affected: false, results: [FULL_FAIL, res(true, '')] });
    expect(argvs).toEqual([FULL, FULL]);
    expect(stub.calls[0]!.prompt).toContain('3. Re-run only the failing command or the smallest relevant');
    expect(logs.some(([t]) => t === 'affected_tests')).toBe(false);
  });
});

const BUILD = ['npm', 'run', 'build'];
const TYPECHECK = ['npx', 'tsc', '-b', '--incremental'];
const OK = res(true, '');
const COMPILE_FAIL = res(false, 'error TS2322');
const TSC = { typecheck: 'npx tsc -b --incremental' };

describe('checkPhase scoped verification (#4251)', () => {
  it('a focused round runs the focused typecheck, logs its exact commands, then one full compile and tests pass', async () => {
    const { result, argvs, logs } = await run({
      compile: true,
      cfg: TSC,
      results: [OK, FULL_FAIL, OK, AFFECTED_PASS, OK, OK],
    });
    expect(argvs).toEqual([BUILD, FULL, TYPECHECK, AFFECTED, BUILD, FULL]);
    expect(result.passed).toBe(true);
    const scopes = logs.filter(([t]) => t === 'verify_scope').map(([, m]) => m);
    expect(scopes[0]).toContain('verify scope (round 0): full — compile');
    expect(scopes.slice(1)).toEqual([
      "verify scope (round 1): focused — typecheck `npx tsc -b --incremental`, tests `npx vitest related --run 'src/my widget.ts'`; full gate pending before SHIP",
      'full gate before SHIP (round 1): npm run build PASS, npm test PASS',
    ]);
  });

  it('keeps reworking when the full compile before SHIP fails', async () => {
    const { result, argvs } = await run({
      compile: true,
      cfg: TSC,
      results: [OK, FULL_FAIL, OK, AFFECTED_PASS, COMPILE_FAIL, OK, OK, AFFECTED_PASS, OK, OK],
    });
    expect(argvs.slice(0, 6)).toEqual([BUILD, FULL, TYPECHECK, AFFECTED, BUILD, FULL]);
    expect(result.reworkRounds).toBeGreaterThan(1);
  });

  it('without tests.affected.typecheck an affected round runs the full compile', async () => {
    const { argvs } = await run({ compile: true, results: [OK, FULL_FAIL, OK, AFFECTED_PASS, OK], maxReworkRounds: 1 });
    expect(argvs.slice(0, 4)).toEqual([BUILD, FULL, BUILD, AFFECTED]);
  });

  it('no diff base runs the full compile and full tests and logs full', async () => {
    const { argvs, logs } = await run({
      compile: true,
      noDiffBase: true,
      cfg: TSC,
      results: [OK, FULL_FAIL, OK, OK],
      maxReworkRounds: 1,
    });
    expect(argvs).toEqual([BUILD, FULL, BUILD, FULL]);
    expect(logs.some(([t, m]) => t === 'affected_tests' && m.includes('no-diff-base'))).toBe(true);
    expect(logs.some(([t, m]) => t === 'verify_scope' && m.includes('(round 1): full —'))).toBe(true);
  });

  it('buildVerify full runs the full gate every round', async () => {
    const { argvs, logs } = await run({
      compile: true,
      cfg: { ...TSC, buildVerify: 'full' },
      results: [OK, FULL_FAIL, OK, OK],
      maxReworkRounds: 1,
    });
    expect(argvs).toEqual([BUILD, FULL, BUILD, FULL]);
    expect(logs).toContainEqual(['affected_tests', 'buildVerify full: running the full gate every round']);
  });

  it('rework instruction names focused commands and says the full gate runs before SHIP', async () => {
    const { stub } = await run({ cfg: TSC, results: [FULL_FAIL, AFFECTED_PASS, OK], maxReworkRounds: 1 });
    const prompt = stub.calls[0]!.prompt;
    expect(prompt).toContain(
      "typecheck `npx tsc -b --incremental`, tests `npx vitest related --run 'src/my widget.ts'`",
    );
    expect(prompt).toContain('Do not also run the full suite; CHECK runs one full gate before SHIP.');
  });
});

const scopeLogs = (logs: Array<[string, string]>) =>
  logs.filter(([t]) => t === 'verify_scope' || t === 'affected_tests').map(([, m]) => m);
const REFUSED = 'fullGate ci refused: no required checks on the base branch; running the full gate in CHECK';
const CI = { fullGate: 'ci' } as const;

describe('checkPhase tests.affected.fullGate (#4293)', () => {
  it('ci: round 0 runs only the focused set and CHECK passes without the full tests command', async () => {
    const { result, argvs, logs } = await run({ cfg: CI, results: [AFFECTED_PASS] });
    expect(argvs).toEqual([AFFECTED]);
    expect(result.passed).toBe(true);
    expect(scopeLogs(logs)).toContain(
      "verify scope (round 0): focused — typecheck `unknown`, tests `npx vitest related --run 'src/my widget.ts'`; full gate: ci (required checks)",
    );
  });

  it('ci: a passing rework round skips the full gate before SHIP and keeps the affected result', async () => {
    const { result, argvs, logs, stub } = await run({ cfg: CI, results: [FULL_FAIL, AFFECTED_PASS] });
    expect(argvs).toEqual([AFFECTED, AFFECTED]);
    expect(result.passed).toBe(true);
    expect(result.summary.results[0]!.details).toContain('affected tests: OK');
    expect(stub.calls[0]!.prompt).toContain("full suite; the PR's required checks run the full gate.");
    expect(scopeLogs(logs).some((m) => m.includes('full gate before SHIP'))).toBe(false);
  });

  it('ci without required checks on the base logs the refusal once and runs the full gate in CHECK', async () => {
    const { argvs, logs } = await run({ cfg: CI, noChecks: true, results: [FULL_FAIL, AFFECTED_PASS, OK] });
    expect(argvs).toEqual([FULL, AFFECTED, FULL]);
    expect(logs.filter(([, m]) => m === REFUSED)).toHaveLength(1);
  });

  it.each([undefined, 'check' as const])('fullGate %s: round 0 full, full gate before SHIP', async (fullGate) => {
    const { result, argvs, logs } = await run({ cfg: { fullGate }, results: [FULL_FAIL, AFFECTED_PASS, OK] });
    expect(argvs).toEqual([FULL, AFFECTED, FULL]);
    expect(result.passed).toBe(true);
    expect(result.summary.results[0]!.details).toBe('checks.test: OK');
    const affected = "affected tests (round 1): affected — npx vitest related --run 'src/my widget.ts' (1 files)";
    expect(scopeLogs(logs)).toEqual([
      'verify scope (round 0): full — compile `unknown`, tests ``',
      affected,
      affected,
      "verify scope (round 1): focused — typecheck `unknown`, tests `npx vitest related --run 'src/my widget.ts'`; full gate pending before SHIP",
      'full gate before SHIP (round 1): npm test PASS',
    ]);
  });

  it('ci with a trigger file in the diff runs the full suite in CHECK', async () => {
    const { result, argvs } = await run({ cfg: CI, files: ['src/a.ts', 'pnpm-lock.yaml'], results: [OK] });
    expect(argvs).toEqual([FULL]);
    expect(result.passed).toBe(true);
  });
});
