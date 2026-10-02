import { execFile as execFileCb } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import type { ModelRouter } from '../router/index.js';
import type { CheckerOutput } from '../types/index.js';
import { runCommand } from '../utils/command-runner.js';
import { BaselineCache, hashBaselineEnv } from './baseline-cache.js';
import { compareBaseline, extractFailingTestNames, runBaselineCheckers } from './baseline.js';
import { type CheckerContext, type runAllCheckers, summarizeCheckerOutputs } from './index.js';

const execFile = promisify(execFileCb);
const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

const out = (checker: string, result: CheckerOutput['result'], details = ''): CheckerOutput => ({
  checker,
  result,
  details,
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFile('git', args, { cwd })).stdout.trim();
}

/** Repo with commit A (base) then commit B (head) and an uncommitted file. */
async function makeRepo(): Promise<{ repo: string; shaA: string; shaB: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'baseline-repo-'));
  tempDirs.add(repo);
  await git(repo, 'init', '--initial-branch=main');
  await git(repo, 'config', 'user.email', 'tests@example.com');
  await git(repo, 'config', 'user.name', 'Tests');
  await writeFile(join(repo, 'f.txt'), 'A');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'A');
  const shaA = await git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'f.txt'), 'B');
  await git(repo, 'commit', '-am', 'B');
  const shaB = await git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'uncommitted.txt'), 'wip');
  return { repo, shaA, shaB };
}

const router = {} as ModelRouter;

function makeOpts(repo: string, shaA: string, extra: Partial<Parameters<typeof runBaselineCheckers>[0]> = {}) {
  const env = { FACTORY_HEADLESS: '1', PORT: '3100' };
  const ctx: CheckerContext = { worktree: repo, specPath: join(repo, 'spec.md'), env };
  return {
    env,
    opts: {
      baseSha: shaA,
      laneWorktree: repo,
      failing: [out('tests', 'FAIL'), out('design_smells', 'FAIL'), out('custom_x', 'FAIL'), out('lint', 'PASS')],
      ctx,
      router,
      constitution: null,
      ...extra,
    },
  };
}

async function worktreeList(repo: string): Promise<string[]> {
  const porcelain = await git(repo, 'worktree', 'list', '--porcelain');
  return porcelain.split('\n').filter((l) => l.startsWith('worktree '));
}

describe('extractFailingTestNames', () => {
  it('parses vitest, TAP and .NET lines, dedupes, and returns [] without names', () => {
    const details = [
      ' FAIL  a.test.ts > one',
      ' × two',
      'not ok 3 - three',
      'failed Ns.Class.Test (12ms)',
      ' FAIL  a.test.ts > one',
    ].join('\n');
    expect(extractFailingTestNames(details)).toEqual(['a.test.ts > one', 'two', 'three', 'Ns.Class.Test']);
    expect(extractFailingTestNames('npm ERR! something')).toEqual([]);
  });
});

describe('compareBaseline', () => {
  it('reports clean-on-base for PASS and SKIP', () => {
    expect(
      compareBaseline([out('tests', 'FAIL'), out('lint', 'FAIL')], [out('tests', 'PASS'), out('lint', 'SKIP')]),
    ).toEqual([
      { checker: 'tests', verdict: 'clean-on-base', baseResult: 'PASS' },
      { checker: 'lint', verdict: 'clean-on-base', baseResult: 'SKIP' },
    ]);
  });

  it('reports fails-on-base, comparing test names when both name tests', () => {
    expect(compareBaseline([out('lint', 'FAIL', 'x')], [out('lint', 'FAIL', 'y')])).toEqual([
      { checker: 'lint', verdict: 'fails-on-base', baseResult: 'FAIL' },
    ]);
    const [c] = compareBaseline([out('tests', 'FAIL', 'FAIL a\nFAIL b')], [out('tests', 'FAIL', 'FAIL a\nFAIL c')]);
    expect(c.sharedFailingTests).toEqual(['a']);
    expect(c.newFailingTests).toEqual(['b']);
  });

  it('reports not-run for diff-scoped, custom and missing checkers', () => {
    const result = compareBaseline(
      [out('worker_output', 'FAIL'), out('design_smells', 'FAIL'), out('custom_x', 'FAIL'), out('tests', 'FAIL')],
      [],
    );
    expect(result.map((r) => r.verdict)).toEqual(['not-run', 'not-run', 'not-run', 'not-run']);
    expect(result[0].reason).toContain('change diff');
    expect(result[2].reason).toContain('spec');
    expect(result[3].reason).toBe('no result on base');
  });
});

describe('runBaselineCheckers', () => {
  it('runs in an isolated detached worktree at the base SHA and cleans up', async () => {
    const { repo, shaA, shaB } = await makeRepo();
    const seen: any = {};
    let parent = '';
    const { env, opts } = makeOpts(repo, shaA, {
      deps: {
        makeTempDir: async () => (parent = await mkdtemp(join(tmpdir(), 'factory-baseline-'))),
        runCheckers: (async (ctx: CheckerContext, _r: unknown, _c: unknown, _t: unknown, only?: readonly string[]) => {
          seen.worktree = ctx.worktree;
          seen.env = ctx.env;
          seen.only = only;
          seen.head = await git(ctx.worktree, 'rev-parse', 'HEAD');
          seen.content = await readFile(join(ctx.worktree, 'f.txt'), 'utf8');
          return summarizeCheckerOutputs([out('tests', 'PASS')]);
        }) as typeof runAllCheckers,
      },
    });

    const report = await runBaselineCheckers(opts);

    expect(seen.worktree).not.toBe(repo);
    expect(seen.env).toBe(env);
    expect(seen.only).toEqual(['tests']);
    expect(seen.head).toBe(shaA);
    expect(seen.content).toBe('A');
    expect(report.checkers.find((c) => c.checker === 'tests')?.verdict).toBe('clean-on-base');
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(shaB);
    expect(await git(repo, 'branch', '--show-current')).toBe('main');
    expect(await readFile(join(repo, 'uncommitted.txt'), 'utf8')).toBe('wip');
    expect(existsSync(parent)).toBe(false);
    expect(await worktreeList(repo)).toHaveLength(1);
  });

  it('cleans up and reports an error when the runner throws', async () => {
    const { repo, shaA } = await makeRepo();
    let parent = '';
    const { opts } = makeOpts(repo, shaA, {
      deps: {
        makeTempDir: async () => (parent = await mkdtemp(join(tmpdir(), 'factory-baseline-'))),
        runCheckers: (async () => {
          throw new Error('kaboom');
        }) as typeof runAllCheckers,
      },
    });
    const report = await runBaselineCheckers(opts);
    expect(report.error).toMatch(/^baseline run failed/);
    expect(existsSync(parent)).toBe(false);
    expect(await worktreeList(repo)).toHaveLength(1);
  });

  it('reports an error for an unresolvable SHA without running checkers', async () => {
    const { repo } = await makeRepo();
    let parent = '';
    let ran = false;
    const { opts } = makeOpts(repo, 'deadbeef'.repeat(5), {
      deps: {
        makeTempDir: async () => (parent = await mkdtemp(join(tmpdir(), 'factory-baseline-'))),
        runCheckers: (async () => {
          ran = true;
          return summarizeCheckerOutputs([]);
        }) as typeof runAllCheckers,
      },
    });
    const report = await runBaselineCheckers(opts);
    expect(report.error).toMatch(/^git worktree add failed/);
    expect(ran).toBe(false);
    expect(existsSync(parent)).toBe(false);
  });

  it('creates nothing when no failing checker is runnable', async () => {
    const { repo, shaA } = await makeRepo();
    let touched = false;
    const { opts } = makeOpts(repo, shaA, {
      failing: [out('design_smells', 'FAIL')],
      deps: {
        makeTempDir: async () => {
          touched = true;
          return '';
        },
        runCheckers: (async () => {
          touched = true;
          return summarizeCheckerOutputs([]);
        }) as typeof runAllCheckers,
      },
    });
    const report = await runBaselineCheckers(opts);
    expect(touched).toBe(false);
    expect(report.checkers.map((c) => c.verdict)).toEqual(['not-run']);
  });
  describe('cache (#1926)', () => {
    const cacheFilePath = async () => {
      const dir = await mkdtemp(join(tmpdir(), 'baseline-cache-'));
      tempDirs.add(dir);
      return join(dir, 'baseline-cache.json');
    };

    /** Records runCheckers filters and git commands; runCheckers returns FAIL for every filter. */
    function recorder() {
      const filters: string[][] = [];
      const commands: string[][] = [];
      const deps = {
        runCommand: ((argv, options) => {
          commands.push([...argv]);
          return runCommand(argv, options);
        }) satisfies typeof runCommand,
        runCheckers: (async (_ctx, _router, _c, _t, only: string[]) => {
          filters.push(only);
          return summarizeCheckerOutputs(only.map((n) => out(n, 'FAIL', 'base')));
        }) as typeof runAllCheckers,
      };
      return { filters, commands, deps };
    }

    it('runs on a miss and stores the base result', async () => {
      const { repo, shaA } = await makeRepo();
      const file = await cacheFilePath();
      const { filters, deps } = recorder();
      const { env, opts } = makeOpts(repo, shaA, { deps, cache: new BaselineCache(file) });
      const report = await runBaselineCheckers(opts);
      expect(filters).toEqual([['tests']]);
      const stored = JSON.parse(await readFile(file, 'utf-8'));
      expect(Object.keys(stored.entries)).toEqual([`${shaA}:${hashBaselineEnv(env)}:tests`]);
      expect(report.checkers.find((c) => c.checker === 'tests')?.cached).toBeUndefined();
    });

    it('reuses a cached result without creating a worktree', async () => {
      const { repo, shaA } = await makeRepo();
      const file = await cacheFilePath();
      const { env, opts } = makeOpts(repo, shaA);
      await new BaselineCache(file).set(shaA, hashBaselineEnv(env), [out('tests', 'FAIL', 'base')]);
      const { filters, commands, deps } = recorder();
      const report = await runBaselineCheckers({ ...opts, deps, cache: new BaselineCache(file) });
      expect(filters).toEqual([]);
      expect(commands.some((c) => c.includes('worktree'))).toBe(false);
      const tests = report.checkers.find((c) => c.checker === 'tests');
      expect(tests?.verdict).toBe('fails-on-base');
      expect(tests?.cached).toBe(true);
      expect(report.checkers.find((c) => c.checker === 'design_smells')?.cached).toBeUndefined();
    });

    it('misses when the applied laneEnv changes', async () => {
      const { repo, shaA } = await makeRepo();
      const file = await cacheFilePath();
      const envA = { FACTORY_HEADLESS: '1' };
      await new BaselineCache(file).set(shaA, hashBaselineEnv(envA), [out('tests', 'FAIL')]);
      const { filters, deps } = recorder();
      const { opts } = makeOpts(repo, shaA, { deps, cache: new BaselineCache(file) });
      await runBaselineCheckers({ ...opts, ctx: { ...opts.ctx, env: {} } });
      expect(filters).toEqual([['tests']]);
      const stored = JSON.parse(await readFile(file, 'utf-8'));
      expect(Object.keys(stored.entries)).toHaveLength(2);
    });

    it('ignores volatile env keys', async () => {
      const { repo, shaA } = await makeRepo();
      const file = await cacheFilePath();
      await new BaselineCache(file).set(shaA, hashBaselineEnv({ FACTORY_HEADLESS: '1', PORT: '4001' }), [
        out('tests', 'FAIL'),
      ]);
      const { filters, deps } = recorder();
      const { opts } = makeOpts(repo, shaA, { deps, cache: new BaselineCache(file) });
      await runBaselineCheckers({ ...opts, ctx: { ...opts.ctx, env: { FACTORY_HEADLESS: '1', PORT: '4002' } } });
      expect(filters).toEqual([]);
    });

    it('runs only the cache misses', async () => {
      const { repo, shaA } = await makeRepo();
      const file = await cacheFilePath();
      const { env, opts } = makeOpts(repo, shaA);
      await new BaselineCache(file).set(shaA, hashBaselineEnv(env), [out('tests', 'FAIL')]);
      const { filters, deps } = recorder();
      const report = await runBaselineCheckers({
        ...opts,
        failing: [out('tests', 'FAIL'), out('lint', 'FAIL')],
        deps,
        cache: new BaselineCache(file),
      });
      expect(filters).toEqual([['lint']]);
      expect(report.checkers.map((c) => [c.checker, c.cached])).toEqual([
        ['tests', true],
        ['lint', undefined],
      ]);
    });

    it('does not cache when the base run throws', async () => {
      const { repo, shaA } = await makeRepo();
      const file = await cacheFilePath();
      const { opts } = makeOpts(repo, shaA, {
        cache: new BaselineCache(file),
        deps: {
          runCheckers: (async () => {
            throw new Error('kaboom');
          }) as typeof runAllCheckers,
        },
      });
      const report = await runBaselineCheckers(opts);
      expect(report.error).toMatch(/^baseline run failed/);
      expect(existsSync(file)).toBe(false);
    });

    it('does not cache when the worktree cannot be created', async () => {
      const { repo } = await makeRepo();
      const file = await cacheFilePath();
      const { opts } = makeOpts(repo, 'deadbeef'.repeat(5), { cache: new BaselineCache(file) });
      const report = await runBaselineCheckers(opts);
      expect(report.error).toMatch(/^git worktree add failed/);
      expect(existsSync(file)).toBe(false);
    });

    it('treats cache read and write errors as misses', async () => {
      const { repo, shaA } = await makeRepo();
      const { filters, deps } = recorder();
      class BrokenCache extends BaselineCache {
        override async get(): Promise<never> {
          throw new Error('read');
        }
        override async set(): Promise<never> {
          throw new Error('write');
        }
      }
      const broken = new BrokenCache('unused');
      const { opts } = makeOpts(repo, shaA, { deps, cache: broken });
      const report = await runBaselineCheckers(opts);
      expect(filters).toEqual([['tests']]);
      expect(report.error).toBeUndefined();
    });
  });
});
