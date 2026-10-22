// packages/cli/src/cli/land.risk-gate.test.ts — the autonomous land path enforces the risk tier before merging (#3381)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import './index.js';
import { AwaitingReviewError } from './land-pr.js';
import { type LandRuntime, setLandRuntime } from './land-runtime.js';
import { landIssue } from './land.js';

// landIssue reads its ops through landRuntime(); outside main()/cmdLand those are the real defaults,
// so register an accessor that layers inert git/shell/CI doubles over them, and put the original back after.
let ops: Record<string, Record<string, unknown>> = {};
let restore: (() => LandRuntime) | undefined;

const tmp = createTempDirs();
let repoRoot = '';
let octokit: any;
let logSpy: any;

function paths(): any {
  const state = join(repoRoot, '.factory', 'state');
  return {
    state,
    plans: join(state, 'plans'),
    events: join(state, 'events.ndjson'),
    mergeLock: join(state, 'merge.lock'),
    gitLock: join(state, 'git.lock'),
    config: join(repoRoot, '.factory', 'config.json'),
  };
}

function makeOctokit(files: string[], labels: string[] = []) {
  return {
    rest: {
      issues: {
        get: vi.fn(async () => ({ data: { title: 'Fix the bug' } })),
        listForRepo: vi.fn(async () => ({ data: [] })),
        listLabelsOnIssue: vi.fn(async () => ({ data: labels.map((name) => ({ name })) })),
        listComments: vi.fn(async () => ({ data: [] })),
        addLabels: vi.fn(async () => ({ data: [] })),
        createComment: vi.fn(async () => ({ data: {} })),
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
        listFiles: vi.fn(async () => ({ data: files.map((filename) => ({ filename })) })),
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

const cleanupWorktree = vi.fn(async () => {});
let trustTier: string | undefined;

beforeEach(() => {
  repoRoot = tmp.makeSync('factory-land-risk-');
  mkdirSync(join(repoRoot, '.git', 'info'), { recursive: true });
  mkdirSync(paths().plans, { recursive: true });
  trustTier = undefined;
  // The factory's own env sets FACTORY_MERGE_ADMIN=1, which would route the merge through `gh --admin`, not octokit.
  vi.stubEnv('FACTORY_MERGE_ADMIN', '');
  restore = setLandRuntime(() => {
    const rt = restore!();
    return {
      ...rt,
      configLoaders: { ...rt.configLoaders, ...ops.configLoaders },
      gitOps: { ...rt.gitOps, ...ops.gitOps },
      internalOps: { ...rt.internalOps, ...ops.internalOps },
      shellOps: { ...rt.shellOps, ...ops.shellOps },
    } as LandRuntime;
  });
  ops = {
    configLoaders: {
      loadFactoryConfigForRepo: () => ({
        merge: { auto: true, comment: '' },
        worktree: { parent: '../', gcTtlDays: 7, autoGcOnRun: false },
        sandbox: { enabled: false, network: { allow: [] }, resources: { cpuMs: 1, memMb: 1 } },
        sweep: { loopIntervalSeconds: 300, staleThresholdMultiplier: 2 },
        filing: { selfFixLabel: 'no-auto-merge', enabled: false },
      }),
      loadRepoConfig: () => (trustTier ? { classifier: { trustTier } } : {}),
    },
    gitOps: { setupWorktree: vi.fn(async () => undefined), cleanupWorktree, gitFetch: vi.fn(async () => {}) },
    internalOps: { watchChecks: vi.fn(async () => 'success') },
    shellOps: {
      exec: vi.fn(async () => ({ stdout: '', stderr: '' })),
      execSync: vi.fn(() => {
        throw new Error('no cli available');
      }),
    },
  };
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  if (restore) setLandRuntime(restore);
  logSpy.mockRestore();
  await tmp.cleanup();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

const land = (enforceRisk: boolean) =>
  landIssue(5, repoRoot, 'on-par/software-factory', paths(), octokit, false, undefined, { enforceRisk });

describe('landIssue risk gate (#3381)', () => {
  it('merges a low-risk PR on the default trust tier, with no risk labels', async () => {
    octokit = makeOctokit(['docs/readme.md']);
    await expect(land(true)).resolves.toMatchObject({ prNumber: 77 });
    expect(octokit.rest.pulls.merge).toHaveBeenCalled();
    expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
  });

  it('holds a high-risk PR: labels it, notifies on the issue, cleans up and never merges', async () => {
    octokit = makeOctokit(['db/migrations/001.sql']);
    trustTier = 'T2';
    const err = await land(true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AwaitingReviewError);
    expect((err as AwaitingReviewError).prNumber).toBe(77);
    expect(octokit.rest.pulls.merge).not.toHaveBeenCalled();
    expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 77, labels: ['risk:high', 'needs-human'] }),
    );
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 5 }));
    expect(cleanupWorktree).toHaveBeenCalled();
  });

  it('holds a med-risk PR unless the repo is T2, and honours needs-human on the issue', async () => {
    octokit = makeOctokit(['packages/core/src/foo.ts']);
    await expect(land(true)).rejects.toBeInstanceOf(AwaitingReviewError);
    expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ['risk:med'] }));

    octokit = makeOctokit(['packages/core/src/foo.ts']);
    trustTier = 'T2';
    await expect(land(true)).resolves.toMatchObject({ prNumber: 77 });

    octokit = makeOctokit(['packages/core/src/foo.ts'], ['needs-human']);
    await expect(land(true)).rejects.toBeInstanceOf(AwaitingReviewError);
    expect(octokit.rest.pulls.merge).not.toHaveBeenCalled();
  });

  it('uses the repo risk policy, so the gate agrees with the risk receipt', async () => {
    mkdirSync(join(repoRoot, '.factory'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.factory', 'config.yaml'),
      "version: 2\nrisk:\n  rules:\n    - id: docs-high\n      tier: high\n      globs: ['docs/**']\n",
    );
    octokit = makeOctokit(['docs/readme.md']);
    await expect(land(true)).rejects.toBeInstanceOf(AwaitingReviewError);
    expect(octokit.rest.issues.createComment.mock.calls[0][0].body).toContain('docs-high');
  });

  it('a human land (no enforceRisk) merges a high-risk PR untouched', async () => {
    octokit = makeOctokit(['db/migrations/001.sql']);
    await expect(land(false)).resolves.toMatchObject({ prNumber: 77 });
    expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });
});
