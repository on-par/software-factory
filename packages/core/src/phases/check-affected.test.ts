import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { BaselineReport } from '../checkers/baseline.js';
import { summarizeCheckerOutputs, testsChecker, type CheckerContext } from '../checkers/index.js';
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

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).flatMap((d) => [rm(d, { recursive: true, force: true }), rm(`${d}.spec.md`, { force: true })]),
  );
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

/** A git worktree whose one committed change since `base` is `files` (default `src/my widget.ts`). */
async function makeRepo(files = ['src/my widget.ts']): Promise<{ worktree: string; base: string }> {
  const worktree = await mkdtemp(join(tmpdir(), 'check-affected-'));
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

async function run(opts: { results: CommandResult[]; files?: string[]; affected?: boolean; maxReworkRounds?: number }) {
  const { worktree, base } = await makeRepo(opts.files);
  const stub = new StubModelExecutor({ defaultOutput: 'rework complete' });
  const router = new ModelRouter(models, routes, false, stub);
  const argvs: string[][] = [];
  const logs: Array<[string, string]> = [];
  const fakeRun = async (argv: readonly string[]) => {
    argvs.push([...argv]);
    return opts.results[argvs.length - 1] ?? FULL_FAIL;
  };
  const result = await checkPhase({
    issue: 3260,
    worktree,
    specPath: `${worktree}.spec.md`,
    router,
    constitution: null,
    maxReworkRounds: opts.maxReworkRounds ?? 3,
    diffBase: base,
    log: (type, msg) => logs.push([type, msg]),
    testsAffected: opts.affected === false ? null : { command: 'npx vitest related --run {files}', fullOn: undefined },
    runBaseline: async (o) => ({ baseSha: o.baseSha, checkers: [] }) as BaselineReport,
    runCheckers: async (ctx: CheckerContext) => {
      ctx.runCommand = fakeRun;
      ctx.checks = { test: 'npm test' };
      return summarizeCheckerOutputs([await testsChecker(ctx)]);
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
