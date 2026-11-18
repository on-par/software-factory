import { workKeyFromIssue } from '../work/work-key.js';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import type { BaselineReport } from '../checkers/baseline.js';
import { compileChecker, summarizeCheckerOutputs, testsChecker, type CheckerContext } from '../checkers/index.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import type { CommandResult } from '../utils/command-runner.js';
import { checkPhase } from './check.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'openai',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub-model'] },
  failover: { triggers: ['rate_limit', 'unavailable', 'auth'], maxRetries: 2, cooldownMs: 0 },
  routingRules: {},
};
const routes: RoutesConfig = { version: 1, routes: { build_claude: { tier: 'boss', description: 'stub' } } };

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

const res = (ok: boolean, stdout: string): CommandResult => ({
  command: [],
  ok,
  stdout,
  stderr: '',
  exitCode: ok ? 0 : 1,
  killed: false,
  timedOut: false,
});
const FULL_FAIL = res(false, ' FAIL  src/a.test.ts > adds\nAssertionError');
const AFFECTED_PASS = res(true, ' Tests  1 passed (1)');

async function run(opts: {
  results: CommandResult[];
  files?: string[];
  affected?: boolean;
  maxReworkRounds?: number;
  typecheck?: string;
  buildVerify?: 'focused' | 'full';
  compile?: boolean;
  noDiffBase?: boolean;
}) {
  const { worktree, base } = await makeAffectedRepo(opts.files);
  const stub = new StubModelExecutor({ defaultOutput: 'rework complete' });
  const router = new ModelRouter(models, routes, false, stub);
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
    testsAffected:
      opts.affected === false
        ? null
        : {
            command: 'npx vitest related --run {files}',
            fullOn: undefined,
            ...(opts.typecheck ? { typecheck: opts.typecheck } : {}),
            ...(opts.buildVerify ? { buildVerify: opts.buildVerify } : {}),
          },
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
  it('tests.affected: round 2 runs the shell-quoted affected command, names it in the rework prompt and logs affected_tests', async () => {
    const { argvs, logs, stub } = await run({ results: [FULL_FAIL, AFFECTED_PASS, res(true, '')], maxReworkRounds: 1 });
    expect(argvs[0]).toEqual(FULL);
    expect(argvs[1]).toEqual(AFFECTED);
    expect(stub.calls[0]!.prompt).toContain("`npx vitest related --run 'src/my widget.ts'`");
    expect(logs.some(([t, m]) => t === 'affected_tests' && m.includes('affected —'))).toBe(true);
  });

  it('tests.affected: a passing affected round requires a full tests pass before CHECK passes; round 1 runs full', async () => {
    const { result, argvs } = await run({ results: [FULL_FAIL, AFFECTED_PASS, res(true, '')] });
    expect(argvs).toEqual([FULL, AFFECTED, FULL]);
    expect(result.passed).toBe(true);
    expect(result.summary.results[0]!.details).toBe('checks.test: OK');
  });

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

describe('checkPhase scoped verification (#4251)', () => {
  it('tests.affected.typecheck: an affected rework round runs the focused typecheck instead of the full compile', async () => {
    const { argvs } = await run({
      compile: true,
      typecheck: 'npx tsc -b --incremental',
      results: [OK, FULL_FAIL, OK, AFFECTED_PASS, OK, OK],
    });
    expect(argvs.slice(0, 4)).toEqual([BUILD, FULL, TYPECHECK, AFFECTED]);
  });

  it('a passing focused round runs one full compile and one full tests pass before CHECK passes', async () => {
    const { result, argvs, logs } = await run({
      compile: true,
      typecheck: 'npx tsc -b --incremental',
      results: [OK, FULL_FAIL, OK, AFFECTED_PASS, OK, OK],
    });
    expect(argvs).toEqual([BUILD, FULL, TYPECHECK, AFFECTED, BUILD, FULL]);
    expect(result.passed).toBe(true);
    expect(logs).toContainEqual(['verify_scope', 'full gate before SHIP (round 1): npm run build PASS, npm test PASS']);
  });

  it('keeps reworking when the full compile before SHIP fails', async () => {
    const { result, argvs } = await run({
      compile: true,
      typecheck: 'npx tsc -b --incremental',
      results: [OK, FULL_FAIL, OK, AFFECTED_PASS, COMPILE_FAIL, OK, OK, AFFECTED_PASS, OK, OK],
    });
    expect(argvs.slice(0, 6)).toEqual([BUILD, FULL, TYPECHECK, AFFECTED, BUILD, FULL]);
    expect(result.reworkRounds).toBeGreaterThan(1);
  });

  it('without tests.affected.typecheck an affected round runs the full compile', async () => {
    const { argvs } = await run({
      compile: true,
      results: [OK, FULL_FAIL, OK, AFFECTED_PASS, OK],
      maxReworkRounds: 1,
    });
    expect(argvs.slice(0, 4)).toEqual([BUILD, FULL, BUILD, AFFECTED]);
  });

  it('no diff base runs the full compile and full tests and logs full', async () => {
    const { argvs, logs } = await run({
      compile: true,
      noDiffBase: true,
      typecheck: 'npx tsc -b --incremental',
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
      buildVerify: 'full',
      typecheck: 'npx tsc -b --incremental',
      results: [OK, FULL_FAIL, OK, OK],
      maxReworkRounds: 1,
    });
    expect(argvs).toEqual([BUILD, FULL, BUILD, FULL]);
    expect(logs).toContainEqual(['affected_tests', 'buildVerify full: running the full gate every round']);
  });

  it('logs verify_scope with the exact focused commands and full gate pending', async () => {
    const { logs } = await run({
      compile: true,
      typecheck: 'npx tsc -b --incremental',
      results: [OK, FULL_FAIL, OK, AFFECTED_PASS, OK, OK],
    });
    const scopes = logs.filter(([t]) => t === 'verify_scope').map(([, m]) => m);
    expect(scopes[0]).toContain('verify scope (round 0): full — compile');
    expect(scopes).toContain(
      "verify scope (round 1): focused — typecheck `npx tsc -b --incremental`, tests `npx vitest related --run 'src/my widget.ts'`; full gate pending before SHIP",
    );
  });

  it('rework instruction names focused commands and says the full gate runs before SHIP', async () => {
    const { stub } = await run({
      typecheck: 'npx tsc -b --incremental',
      results: [FULL_FAIL, AFFECTED_PASS, OK],
      maxReworkRounds: 1,
    });
    const prompt = stub.calls[0]!.prompt;
    expect(prompt).toContain(
      "typecheck `npx tsc -b --incremental`, tests `npx vitest related --run 'src/my widget.ts'`",
    );
    expect(prompt).toContain('Do not also run the full suite; CHECK runs one full gate before SHIP.');
  });
});
