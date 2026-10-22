// packages/cli/src/cli/land.risk-receipt.test.ts — land publishes the risk receipt before merging (#3386)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
        list: vi.fn(async ({ state }: any) =>
          state === 'open'
            ? {
                data: [
                  {
                    number: 77,
                    head: {
                      ref: 'ship-it/5-fix-the-bug',
                      repo: { full_name: 'on-par/software-factory' },
                      sha: 'abc123',
                    },
                    body: 'Closes #5',
                  },
                ],
              }
            : { data: [] },
        ),
        get: vi.fn(async () => ({ data: { head: { sha: 'abc123' }, body: 'Closes #5' } })),
        listFiles: vi.fn(async () => ({ data: [{ filename: 'docs/x.md' }] })),
        update: vi.fn(async () => ({})),
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

describe('land risk receipt', () => {
  it('publishes the risk receipt on the PR before merging', async () => {
    await runMain('land', '5');
    const { update, merge } = h.octokit.rest.pulls;
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 77,
        body: expect.stringMatching(/<!-- factory:risk-receipt v1 -->[\s\S]*\*\*Tier: low\*\*/),
      }),
    );
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(merge.mock.invocationCallOrder[0]);
  });

  it('still merges when the risk receipt cannot be published', async () => {
    h.octokit.rest.pulls.listFiles = vi.fn(async () => {
      throw new Error('boom');
    });
    await runMain('land', '5');
    expect(h.octokit.rest.pulls.merge).toHaveBeenCalled();
    const events = readFileSync(paths().events, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.some((e) => e.type === 'warn' && JSON.stringify(e).includes('risk receipt'))).toBe(true);
  });

  it('prints the configured risk policy and applies it to the receipt', async () => {
    mkdirSync(join(h.repoRoot, '.factory'), { recursive: true });
    writeFileSync(
      join(h.repoRoot, '.factory', 'config.yaml'),
      "version: 2\nrisk:\n  rules:\n    - id: sf-docs-high\n      tier: high\n      globs: ['docs/**']\n",
    );
    await runMain('land', '5');
    expect(logSpy).toHaveBeenCalledWith('risk policy: .factory/config.yaml `risk` (1 rule)');
    const body = h.octokit.rest.pulls.update.mock.calls[0][0].body;
    expect(body).toMatch(/\*\*Tier: high\*\*/);
    expect(body).toContain('sf-docs-high');
  });

  it('prints that no risk policy is configured', async () => {
    await runMain('land', '5');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no risk policy configured'));
    expect(h.octokit.rest.pulls.update.mock.calls[0][0].body).toMatch(/\*\*Tier: low\*\*/);
  });
});
