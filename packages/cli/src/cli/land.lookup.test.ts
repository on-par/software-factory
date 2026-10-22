// packages/cli/src/cli/land.lookup.test.ts — land's PR lookup: ambiguous, fork-only and lookup-failure outcomes (#3439)
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CliDeps, main } from './index.js';

// Shared mutable state the fakes read from. Reset per test in beforeEach.
const h = {
  repoRoot: '',
  ghRepo: 'on-par/software-factory',
  execImpl: (_cmd: string): string => '',
  execSyncImpl: (_cmd: string): string => {
    throw new Error('execSync not stubbed');
  },
  octokit: {} as any,
  factoryConfig: {} as any,
  setupWorktreeImpl: async (_repoRoot: string, _branch: string, _worktree: string, _startPoint?: string) => {},
};

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let exitSpy: any, logSpy: any, errSpy: any;
const savedEnv: Record<string, string | undefined> = {};
const tmp = createTempDirs();

function paths() {
  const state = join(h.repoRoot, '.factory', 'state');
  return {
    state,
    plans: join(state, 'plans'),
    events: join(state, 'events.ndjson'),
    mergeLock: join(state, 'merge.lock'),
    gitLock: join(state, 'git.lock'),
  };
}

function defaultOctokit() {
  return {
    rest: {
      issues: {
        get: vi.fn(async () => ({ data: { title: 'Fix the bug' } })),
        listForRepo: vi.fn(async () => ({ data: [] })),
        listLabelsOnIssue: vi.fn(async () => ({ data: [] })),
        listComments: vi.fn(async () => ({ data: [] })),
      },
      users: { getAuthenticated: vi.fn(async () => ({ data: { id: 7 } })) },
      pulls: {
        list: vi.fn(async () => ({ data: [] })),
        get: vi.fn(async () => ({ data: { head: { sha: 'abc123' } } })),
        merge: vi.fn(async () => ({})),
      },
      git: { deleteRef: vi.fn(async () => ({})) },
      checks: { listForRef: vi.fn(async () => ({ data: { check_runs: [] } })) },
      search: { issuesAndPullRequests: vi.fn(async () => ({ data: { items: [] } })) },
    },
    graphql: vi.fn(async (query: string) =>
      query.trimStart().startsWith('query')
        ? { repository: { pullRequest: { id: 'PR_ID', isDraft: false, mergeStateStatus: 'CLEAN' } } }
        : {},
    ),
  };
}

const inertConfigLoaders: Pick<
  CliDeps,
  | 'loadModelsConfig'
  | 'loadRoutesConfig'
  | 'loadFactoryConfigForRepo'
  | 'resolveTimeouts'
  | 'resolveSkipCI'
  | 'getConstitutionsDir'
  | 'resolveEffectiveModelPins'
> = {
  loadModelsConfig: () => ({ models: {}, tiers: {} }) as never,
  loadRoutesConfig: () => ({}) as never,
  loadFactoryConfigForRepo: () => h.factoryConfig,
  resolveTimeouts: () => ({ plan: 1, build: 1, check: 1, approval: 1, tests: 1, compile: 1 }),
  resolveSkipCI: () => false,
  getConstitutionsDir: vi.fn(() => ''),
  resolveEffectiveModelPins: vi.fn(() => ({ sources: {} })) as never,
};

/** Git side-effect doubles injected through the CliDeps seams (#2019). setupWorktree delegates to h.setupWorktreeImpl. */
const setupWorktree = vi.fn(async (...args: Parameters<NonNullable<CliDeps['setupWorktree']>>) => {
  await h.setupWorktreeImpl(args[0], args[1], args[2], args[3]);
  return undefined as never;
});
const cleanupWorktree = vi.fn(async (..._args: Parameters<NonNullable<CliDeps['cleanupWorktree']>>) => {});
const gitFetch = vi.fn(async (_repoRoot: string) => {});
const inertGitOps: Pick<CliDeps, 'setupWorktree' | 'cleanupWorktree' | 'gitFetch'> = {
  setupWorktree,
  cleanupWorktree,
  gitFetch,
};

function makeInternalFakes() {
  return {
    watchChecks: vi.fn(async () => 'success') as any,
    exec: vi.fn(async (cmd: string) => ({ stdout: h.execImpl(cmd), stderr: '' })),
    execSync: vi.fn((cmd: string) => h.execSyncImpl(cmd)),
    octokit: () => h.octokit,
  } satisfies Pick<CliDeps, 'watchChecks' | 'exec' | 'execSync' | 'octokit'>;
}
let ops = makeInternalFakes();

async function runMain(...args: string[]) {
  process.argv = ['node', 'factory', ...args];
  try {
    await main(['node', 'factory', ...args], { ...inertConfigLoaders, ...inertGitOps, ...ops });
  } catch (err) {
    if (err instanceof ExitError) return { exited: true as const, code: err.code };
    throw err;
  }
  const code = process.exitCode as number | undefined;
  process.exitCode = undefined;
  return code === undefined ? { exited: false as const, code: undefined } : { exited: true as const, code };
}

beforeEach(() => {
  ops = makeInternalFakes();
  h.repoRoot = tmp.makeSync('factory-cli-');
  mkdirSync(join(h.repoRoot, '.git', 'info'), { recursive: true });
  mkdirSync(paths().state, { recursive: true });
  mkdirSync(paths().plans, { recursive: true });

  h.execImpl = (cmd: string) => {
    if (cmd.includes('rev-parse')) return h.repoRoot;
    if (cmd.includes('gh repo view')) return h.ghRepo;
    return '';
  };
  h.execSyncImpl = (_cmd: string) => {
    throw new Error('no cli available');
  };
  h.octokit = defaultOctokit();
  // landIssue reads the filing policy for the no-auto-merge gate (#1720).
  h.factoryConfig = {
    merge: { auto: false, comment: '' },
    worktree: { parent: '../', gcTtlDays: 7, autoGcOnRun: false },
    sandbox: {
      enabled: true,
      network: { allow: ['api.anthropic.com', 'github.com'] },
      resources: { cpuMs: 300_000, memMb: 4096 },
    },
    sweep: { loopIntervalSeconds: 300, staleThresholdMultiplier: 2 },
    filing: { selfFixLabel: 'no-auto-merge', enabled: false },
  };
  h.setupWorktreeImpl = async () => {};
  for (const k of ['FACTORY_LOCAL_ONLY', 'FACTORY_MERGE', 'FACTORY_MERGE_ADMIN', 'FACTORY_SKIP_CI']) {
    savedEnv[k] = process.env[k];
  }
  savedEnv.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  savedEnv.GH_TOKEN = process.env.GH_TOKEN;
  delete process.env.FACTORY_LOCAL_ONLY;
  delete process.env.FACTORY_MERGE;
  delete process.env.FACTORY_MERGE_ADMIN;
  delete process.env.GITHUB_TOKEN;
  process.env.GH_TOKEN = 'test-token';
  process.exitCode = undefined;

  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as any);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await tmp.cleanup();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.exitCode = undefined;
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  vi.clearAllMocks();
});

function errored(): string {
  return errSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
}

describe('land PR lookup', () => {
  const prFixture = (number: number, ref: string, repo: string) => ({
    number,
    head: { ref, repo: { full_name: repo }, sha: 'abc123' },
    body: 'Closes #5',
  });

  it('exits 1 naming both PRs when two same-repo PRs close the issue (#3439)', async () => {
    h.octokit.rest.pulls.list = vi.fn(async ({ head }: { head?: string }) =>
      head
        ? { data: [] }
        : {
            data: [
              prFixture(77, 'ship-it/5-a', 'on-par/software-factory'),
              prFixture(78, 'ship-it/5-b', 'on-par/software-factory'),
            ],
          },
    );
    const res = await runMain('land', '5');
    expect(res).toEqual({ exited: true, code: 1 });
    expect(errored()).toContain('#77');
    expect(errored()).toContain('#78');
    expect(errored()).toContain('--branch');
    expect(h.octokit.rest.pulls.merge).not.toHaveBeenCalled();
    expect(setupWorktree).not.toHaveBeenCalled();
  });

  it('reports no open PR and sets up no worktree when only a fork PR closes the issue (#3439)', async () => {
    h.octokit.rest.pulls.list = vi.fn(async ({ head }: { head?: string }) =>
      head ? { data: [] } : { data: [prFixture(77, 'ship-it/5-a', 'someone/software-factory')] },
    );
    const res = await runMain('land', '5');
    expect(res).toEqual({ exited: true, code: 1 });
    expect(errored()).toContain('no open PR for issue #5');
    expect(setupWorktree).not.toHaveBeenCalled();
    expect(h.octokit.rest.pulls.merge).not.toHaveBeenCalled();
  });

  it('wraps a by-issue PR lookup failure as code 5, never "no open PR" (#3439)', async () => {
    h.octokit.rest.pulls.list = vi.fn(async ({ head }: { head?: string }) => {
      if (head) return { data: [] };
      throw new Error('rate limited');
    });
    const res = await runMain('land', '5');
    expect(res).toEqual({ exited: true, code: 5 });
    expect(errored()).toContain('PR lookup failed for issue #5');
    expect(errored()).toContain('rate limited');
    expect(errored()).not.toContain('no open PR');
  });
});
