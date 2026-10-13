// packages/cli/src/cli/land.test.ts — land command tests via main() and direct cmdLand (#2785)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CliDeps, cmdLand as cliCmdLand, main } from './index.js';

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

let exitSpy: any;
let logSpy: any;
let errSpy: any;
const savedEnv: Record<string, string | undefined> = {};

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
            ? { data: [{ number: 77, head: { ref: 'ship-it/5-fix-the-bug' }, body: 'Closes #5' }] }
            : { data: [] },
        ),
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
  resolveTimeouts: () => ({ plan: 1, build: 1, check: 1, approval: 1, tests: 1 }),
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

/** Direct cmdLand calls get the inert loaders (incl. h.factoryConfig) unless a test passes its own. */
function cmdLand(...[issueNum, opts, deps]: Parameters<typeof cliCmdLand>) {
  return cliCmdLand(issueNum, opts, { ...inertConfigLoaders, ...inertGitOps, ...ops, ...deps });
}

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
  h.repoRoot = mkdtempSync(join(tmpdir(), 'factory-cli-'));
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

afterEach(() => {
  rmSync(h.repoRoot, { recursive: true, force: true });
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

function logged(): string {
  return logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
}
function errored(): string {
  return errSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
}

describe('land (via main dispatch)', () => {
  it('exits 2 when --branch-prefix has no letters or digits', async () => {
    const res = await runMain('land', '5', '--branch-prefix', '!!!');
    expect(res).toEqual({ exited: true, code: 2 });
    expect(errored()).toContain('--branch-prefix');
  });

  it('lands an open PR and prints success', async () => {
    const res = await runMain('land', '5');
    expect(res.exited).toBe(false);
    expect(logged()).toContain('Landed PR #77');
    expect(h.octokit.rest.pulls.merge).toHaveBeenCalled();
  });

  it('exits 1 when there is no open PR for the issue', async () => {
    h.octokit.rest.pulls.list = vi.fn(async () => ({ data: [] }));
    const res = await runMain('land', '5');
    expect(res).toEqual({ exited: true, code: 1 });
    expect(errored()).toContain('no open PR');
  });

  it('exits 3 on a rebase conflict (LandConflictError)', async () => {
    h.octokit.graphql = vi.fn(async (query: string) =>
      query.trimStart().startsWith('query')
        ? { repository: { pullRequest: { id: 'PR_ID', isDraft: false, mergeStateStatus: 'DIRTY' } } }
        : {},
    );
    // worktree does not exist -> DIRTY with missing worktree -> LandConflictError
    const res = await runMain('land', '5');
    expect(res).toEqual({ exited: true, code: 3 });
    expect(errored()).toContain('factory:');
  });

  it('wraps a PR-lookup failure as a code-5 CliExitError naming the issue and branch', async () => {
    h.octokit.rest.pulls.list = vi.fn(async ({ state }: any) => {
      if (state === 'open') throw new Error('rate limited');
      return { data: [] };
    });
    const res = await runMain('land', '5');
    expect(res).toEqual({ exited: true, code: 5 });
    expect(errored()).toContain('PR lookup failed for issue #5');
    expect(errored()).toContain('rate limited');
  });

  it("routes landIssue's fetch through the injected gitFetch (#2019)", async () => {
    await runMain('land', '5');
    expect(gitFetch).toHaveBeenCalledWith(h.repoRoot);
  });

  it('wraps a post-merge cleanup failure as a code-5 CliExitError', async () => {
    vi.mocked(cleanupWorktree).mockRejectedValueOnce(new Error('rm -rf failed'));
    const res = await runMain('land', '5');
    expect(res).toEqual({ exited: true, code: 5 });
    expect(errored()).toContain('merge failed for issue #5');
    expect(errored()).toContain('rm -rf failed');
  });

  it('wraps an unexpected pre-lock failure (e.g. issue lookup) in a generic code-5 CliExitError', async () => {
    h.octokit.rest.issues.get = vi.fn(async () => {
      throw new Error('issue vanished');
    });
    const res = await runMain('land', '5');
    expect(res).toEqual({ exited: true, code: 5 });
    expect(errored()).toContain('merge failed for issue #5');
    expect(errored()).toContain('issue vanished');
  });

  it('scopes the git/merge locks to mutations, not the CI watch (#645)', async () => {
    const watched: string[] = [];
    const mergeLockHeld: boolean[] = [];
    ops.watchChecks.mockImplementation(async () => {
      watched.push(`merge=${existsSync(paths().mergeLock)}:git=${existsSync(paths().gitLock)}`);
      return 'success' as const;
    });
    cleanupWorktree.mockImplementationOnce(async () => {
      mergeLockHeld.push(existsSync(paths().mergeLock));
    });
    const merge = h.octokit.rest.pulls.merge;
    h.octokit.rest.pulls.merge = vi.fn(async (...args: unknown[]) => {
      mergeLockHeld.push(existsSync(paths().mergeLock));
      return (merge as any)(...args);
    }) as never;

    try {
      const res = await runMain('land', '5');
      expect(res.exited).toBe(false);

      expect(watched.length).toBeGreaterThan(0);
      expect(watched.every((w) => w === 'merge=false:git=false')).toBe(true);
      expect(mergeLockHeld.length).toBeGreaterThanOrEqual(2);
      expect(mergeLockHeld.every(Boolean)).toBe(true);
    } finally {
      ops.watchChecks.mockImplementation(async () => 'success');
    }
  });
});

describe('cmdLand (direct invocation)', () => {
  it('cmdLand(5) rejects with code 1 when there is no open PR', async () => {
    h.octokit.rest.pulls.list = vi.fn(async () => ({ data: [] }));
    await expect(cmdLand(5)).rejects.toMatchObject({
      name: 'CliExitError',
      code: 1,
      message: expect.stringContaining('no open PR'),
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('cmdLand uses an injected loadFactoryConfigForRepo', async () => {
    h.octokit.rest.pulls.list = vi.fn(async () => ({ data: [] }));
    const load = vi.fn(() => h.factoryConfig);
    await expect(
      cliCmdLand(5, {}, { ...inertConfigLoaders, ...inertGitOps, ...ops, loadFactoryConfigForRepo: load }),
    ).rejects.toMatchObject({
      code: 1,
    });
    expect(load).toHaveBeenCalledWith(expect.stringMatching(/\.factory\/config\.(json|yaml)$/));
  });

  describe('cmdLand no-auto-merge gate (#1720)', () => {
    const labelsFor = (gated: number[]) =>
      vi.fn(async ({ issue_number }: { issue_number: number }) => ({
        data: gated.includes(issue_number) ? [{ name: 'no-auto-merge' }] : [],
      }));
    const eventsOf = () =>
      readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));

    it('refuses with code 4 when the issue carries the gate label', async () => {
      h.octokit.rest.issues.listLabelsOnIssue = labelsFor([5]);
      ops.watchChecks.mockResolvedValue('success');
      await expect(cmdLand(5)).rejects.toMatchObject({
        name: 'CliExitError',
        code: 4,
        message: expect.stringMatching(
          /no-auto-merge[\s\S]*#5[\s\S]*--allow-gated|#5[\s\S]*no-auto-merge[\s\S]*--allow-gated/,
        ),
      });
      expect(h.octokit.rest.pulls.merge).not.toHaveBeenCalled();
      expect(setupWorktree).not.toHaveBeenCalled();
      expect(eventsOf().some((e) => e.type === 'merge-gated' && String(e.issue) === '5')).toBe(true);
    });

    it('refuses when only the PR carries the gate label', async () => {
      h.octokit.rest.issues.listLabelsOnIssue = labelsFor([77]);
      await expect(cmdLand(5)).rejects.toMatchObject({
        code: 4,
        message: expect.stringContaining('PR #77 is labelled no-auto-merge'),
      });
      expect(h.octokit.rest.pulls.merge).not.toHaveBeenCalled();
    });

    it('fails closed when labels cannot be read', async () => {
      h.octokit.rest.issues.listLabelsOnIssue = vi.fn(async () => {
        throw new Error('boom');
      });
      await expect(cmdLand(5)).rejects.toMatchObject({
        code: 4,
        message: expect.stringContaining('could not be read'),
      });
      expect(h.octokit.rest.pulls.merge).not.toHaveBeenCalled();
    });

    it('--allow-gated merges past the gate with an AUDIT line and a merge-gated-override event', async () => {
      h.octokit.rest.issues.listLabelsOnIssue = labelsFor([5]);
      ops.watchChecks.mockResolvedValue('success');
      await expect(cmdLand(5, { allowGated: true })).resolves.toBeUndefined();
      expect(h.octokit.rest.pulls.merge).toHaveBeenCalled();
      expect(logged()).toMatch(/^AUDIT .*#5/m);
      expect(eventsOf().some((e) => e.type === 'merge-gated-override' && String(e.issue) === '5')).toBe(true);
    });
  });

  it('materializes a missing adopted PR worktree from its remote head, rebases it, and rechecks CI', async () => {
    const branch = 'contributor/adopted-pr';
    const worktree = `${h.repoRoot}-factory-factory-5`;
    const commands: string[] = [];
    const originalExec = h.execImpl;
    h.execImpl = (command) => {
      commands.push(command);
      return originalExec(command);
    };
    h.octokit.rest.pulls.list = vi.fn(async ({ head }: { head?: string }) =>
      head ? { data: [] } : { data: [{ number: 77, head: { ref: branch }, body: 'Closes #5' }] },
    );
    h.octokit.graphql = vi.fn(async (query: string) =>
      query.trimStart().startsWith('query')
        ? { repository: { pullRequest: { id: 'PR_1', isDraft: false, mergeStateStatus: 'DIRTY' } } }
        : {},
    );
    h.setupWorktreeImpl = async (_repoRoot, _branch, path) => {
      mkdirSync(path, { recursive: true });
    };
    ops.watchChecks.mockResolvedValue('success');

    try {
      await expect(cmdLand(5)).resolves.toBeUndefined();
      expect(setupWorktree).toHaveBeenCalledWith(
        h.repoRoot,
        branch,
        worktree,
        `origin/${branch}`,
        undefined,
        expect.any(Function),
      );
      expect(commands).toContain('git rebase origin/main');
      expect(commands).toContain("git push --force-with-lease origin 'contributor/adopted-pr'");
      expect(ops.watchChecks).toHaveBeenCalledTimes(2);
      expect(h.octokit.rest.pulls.merge).toHaveBeenCalledWith({
        owner: 'on-par',
        repo: 'software-factory',
        pull_number: 77,
        merge_method: 'squash',
        sha: 'abc123',
      });
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('cmdLand(5) resolves cleanly and leaves the PR open when the merge is blocked on a required review', async () => {
    h.octokit.graphql = vi.fn(async (query: string) =>
      query.trimStart().startsWith('query')
        ? {
            repository: {
              pullRequest: {
                id: 'PR_1',
                isDraft: false,
                mergeStateStatus: 'BLOCKED',
                reviewDecision: 'REVIEW_REQUIRED',
              },
            },
          }
        : {},
    );
    h.octokit.rest.pulls.merge = vi.fn(async () => {
      throw new Error('At least 1 approving review is required by reviewers with write access.');
    });

    await expect(cmdLand(5)).resolves.toBeUndefined();

    expect(logged()).toContain('awaiting human review');
    expect(cleanupWorktree).toHaveBeenCalled();

    const events = readFileSync(paths().events, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.some((e) => e.type === 'awaiting-review')).toBe(true);
  });

  it('cmdLand(5) resolves cleanly and leaves the PR open when CI reports a confirmed failure (regression: owner/example-app#707 merged with a failing e2e check)', async () => {
    ops.watchChecks.mockResolvedValueOnce('failure');

    await expect(cmdLand(5)).resolves.toBeUndefined();

    expect(logged()).toContain('failing CI check');
    expect(logged()).toContain('left open, not merged');
    expect(h.octokit.rest.pulls.merge).not.toHaveBeenCalled();
    expect(cleanupWorktree).toHaveBeenCalled();

    const events = readFileSync(paths().events, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.some((e) => e.type === 'ci-failed')).toBe(true);
  });

  it('cmdLand(5) resolves cleanly and leaves the PR open when CI never reaches a green verdict (timeout)', async () => {
    ops.watchChecks.mockResolvedValueOnce('timeout');

    await expect(cmdLand(5)).resolves.toBeUndefined();

    expect(logged()).toContain('left open, not merged');
    expect(h.octokit.rest.pulls.merge).not.toHaveBeenCalled();
    expect(cleanupWorktree).toHaveBeenCalled();

    const events = readFileSync(paths().events, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.some((e) => e.type === 'ci-failed')).toBe(true);
  });

  it('cmdLand uses an injected octokit factory', async () => {
    const fake = defaultOctokit();
    fake.rest.pulls.list = vi.fn(async () => ({ data: [] }));
    const factory = vi.fn(() => fake as never);

    await expect(cmdLand(5, {}, { octokit: factory })).rejects.toMatchObject({ code: 1 });

    expect(factory).toHaveBeenCalled();
    expect(fake.rest.pulls.list).toHaveBeenCalled();
  });
});
