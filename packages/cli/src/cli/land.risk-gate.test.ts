// packages/cli/src/cli/land.risk-gate.test.ts — the autonomous land path enforces the risk tier before merging (#3381)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Octokit } from '@octokit/rest';
import {
  createGitHubCredentialBroker,
  installGitHubScopeGuard,
  PhaseCredentialHolder,
  type resolveGitHubCredentialSource,
} from '@on-par/factory-core/internal';
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
let calls: Array<[string, any]> = [];
const rec = (key: string, res: unknown) => async (args: any) => (calls.push([key, args]), res);
const of = (key: string) => calls.filter(([k]) => k === key).map(([, a]) => a);

function paths(): any {
  const state = join(repoRoot, '.factory', 'state');
  return {
    state,
    plans: join(state, 'plans'),
    tierDemotions: join(state, 'tier-demotions.jsonl'),
    events: join(state, 'events.ndjson'),
    mergeLock: join(state, 'merge.lock'),
    landSlotLock: join(state, 'land-slot.lock'),
    gitLock: join(state, 'git.lock'),
    config: join(repoRoot, '.factory', 'config.json'),
  };
}

function makeOctokit(files: string[], labels: string[] = []) {
  return {
    rest: {
      issues: {
        get: rec('issues.get', { data: { title: 'Fix the bug' } }),
        listForRepo: vi.fn(async () => ({ data: [] })),
        listLabelsOnIssue: rec('issues.listLabelsOnIssue', { data: labels.map((name) => ({ name })) }),
        listComments: vi.fn(async () => ({ data: [] })),
        addLabels: rec('issues.addLabels', { data: [] }),
        createComment: rec('issues.createComment', { data: {} }),
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
        get: vi.fn(async () => ({
          data: { head: { sha: 'abc123' }, base: { ref: 'main' }, merge_commit_sha: 'merged', body: 'Closes #5' },
        })),
        listFiles: vi.fn(async () => ({ data: files.map((filename) => ({ filename })) })),
        update: vi.fn(async () => ({})),
        merge: rec('pulls.merge', {}),
      },
      git: { deleteRef: vi.fn(async () => ({})) },
      repos: {
        getBranch: vi.fn(async () => ({ data: { commit: { sha: 'base' } } })),
        getStatusChecksProtection: vi.fn(async () => ({ data: { contexts: [] } })),
        getBranchRules: vi.fn(async () => ({ data: [] })),
      },
      actions: { listWorkflowRunsForRepo: vi.fn(async () => ({ data: { workflow_runs: [] } })) },
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

const cleanupWorktree = rec('cleanup', undefined);
let trustTier: string | undefined;

beforeEach(() => {
  repoRoot = tmp.makeSync('factory-land-risk-');
  mkdirSync(join(repoRoot, '.git', 'info'), { recursive: true });
  mkdirSync(paths().plans, { recursive: true });
  trustTier = undefined;
  calls = [];
  // The factory's own env (FACTORY_MERGE_ADMIN=1, ...) would change how land merges; isolate the suite from it (#3428).
  for (const k of ['FACTORY_LOCAL_ONLY', 'FACTORY_MERGE', 'FACTORY_MERGE_ADMIN', 'FACTORY_SKIP_CI'])
    vi.stubEnv(k, undefined);
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
  it('issueless lands by branch without reading the issue title or issue labels (#3905)', async () => {
    octokit = makeOctokit(['docs/readme.md']);
    const res = await landIssue(900, repoRoot, 'on-par/software-factory', paths(), octokit, false, undefined, {
      branch: 'ship-it/5-fix-the-bug',
      issueless: true,
    });
    expect(res).toEqual({ branch: 'ship-it/5-fix-the-bug', prNumber: 77 });
    expect(of('issues.get')).toEqual([]);
    expect(of('issues.listLabelsOnIssue')).toEqual([expect.objectContaining({ issue_number: 77 })]);
    expect(of('pulls.merge')).toEqual([expect.objectContaining({ pull_number: 77 })]);
  });

  it('issueless without a branch fails with exit 1 (#3905)', async () => {
    octokit = makeOctokit([]);
    await expect(
      landIssue(900, repoRoot, 'on-par/software-factory', paths(), octokit, false, undefined, { issueless: true }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('merges a low-risk PR on the default trust tier, with no risk labels', async () => {
    octokit = makeOctokit(['docs/readme.md']);
    await expect(land(true)).resolves.toMatchObject({ prNumber: 77 });
    expect(of('pulls.merge')).toEqual([expect.objectContaining({ pull_number: 77 })]);
    expect(of('issues.addLabels')).toEqual([]);
  });

  it('holds a high-risk PR: labels it, notifies on the issue, cleans up and never merges', async () => {
    octokit = makeOctokit(['db/migrations/001.sql']);
    trustTier = 'T2';
    const err = await land(true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AwaitingReviewError);
    expect((err as AwaitingReviewError).prNumber).toBe(77);
    expect((err as AwaitingReviewError).gate).toBe('risk');
    expect(of('pulls.merge')).toEqual([]);
    expect(of('issues.addLabels')).toContainEqual(
      expect.objectContaining({ issue_number: 77, labels: ['risk:high', 'needs-human'] }),
    );
    expect(of('issues.createComment')).toContainEqual(expect.objectContaining({ issue_number: 5 }));
    expect(of('cleanup')).not.toEqual([]);
  });

  it('holds a med-risk PR unless the repo is T2, and honours needs-human on the issue', async () => {
    octokit = makeOctokit(['packages/core/src/foo.ts']);
    await expect(land(true)).rejects.toBeInstanceOf(AwaitingReviewError);
    expect(of('issues.addLabels')).toContainEqual(expect.objectContaining({ labels: ['risk:med'] }));

    octokit = makeOctokit(['packages/core/src/foo.ts']);
    trustTier = 'T2';
    await expect(land(true)).resolves.toMatchObject({ prNumber: 77 });

    octokit = makeOctokit(['packages/core/src/foo.ts'], ['needs-human']);
    await expect(land(true)).rejects.toBeInstanceOf(AwaitingReviewError);
    expect(of('pulls.merge')).toHaveLength(1);
  });

  it('an unacknowledged demotion holds a med-risk PR at configured T2', async () => {
    octokit = makeOctokit(['packages/core/src/foo.ts']);
    trustTier = 'T2';
    const open = { type: 'tier-demoted', from: 'T2', to: 'T1', prNumber: 3, acknowledgedAt: null };
    mkdirSync(join(paths().tierDemotions, '..'), { recursive: true });
    writeFileSync(paths().tierDemotions, `${JSON.stringify(open)}\n`);
    await expect(land(true)).rejects.toBeInstanceOf(AwaitingReviewError);
    expect(of('pulls.merge')).toEqual([]);
  });

  it('uses the repo risk policy, so the gate agrees with the risk receipt', async () => {
    mkdirSync(join(repoRoot, '.factory'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.factory', 'config.yaml'),
      "version: 2\nrisk:\n  rules:\n    - id: docs-high\n      tier: high\n      globs: ['docs/**']\n",
    );
    octokit = makeOctokit(['docs/readme.md']);
    await expect(land(true)).rejects.toBeInstanceOf(AwaitingReviewError);
    expect(of('issues.createComment')[0].body).toContain('docs-high');
  });

  it('a human land (no enforceRisk) merges a high-risk PR untouched', async () => {
    octokit = makeOctokit(['db/migrations/001.sql']);
    await expect(land(false)).resolves.toMatchObject({ prNumber: 77 });
    expect(of('issues.addLabels')).toEqual([]);
    expect(of('issues.createComment')).toEqual([]);
  });
});

type CredentialSource = ReturnType<typeof resolveGitHubCredentialSource>['source'];

const REPO = 'on-par/software-factory';

async function guardedLandClient(files: string[]) {
  const source: CredentialSource = {
    kind: 'fine-grained',
    lease: async (phase) => ({ phase, kind: 'fine-grained', token: `tok-${phase}`, release: async () => {} }),
  };
  const holder = new PhaseCredentialHolder(createGitHubCredentialBroker({ repo: REPO, source }), {
    checkToken: () => undefined,
    initialPhase: 'land',
  });
  await holder.enter('land');
  octokit = installGitHubScopeGuard(Object.assign(new Octokit(), makeOctokit(files)), { repo: REPO, holder });
  return holder;
}

describe('landIssue scoped merge (#4120)', () => {
  it('does not enable a scoped merge when the risk gate holds the PR', async () => {
    const holder = await guardedLandClient(['db/migrations/001.sql']);
    trustTier = 'T2';
    await expect(land(true)).rejects.toBeInstanceOf(AwaitingReviewError);
    expect(holder.mergeAllowed).toBe(false);
  });

  it('enables a scoped merge after the risk gate allows it', async () => {
    const holder = await guardedLandClient(['docs/readme.md']);
    expect(holder.mergeAllowed).toBe(false);
    await expect(land(true)).resolves.toMatchObject({ prNumber: 77 });
    expect(holder.mergeAllowed).toBe(true);
  });

  it('enables a scoped merge for a human land that skips the gate', async () => {
    const holder = await guardedLandClient(['db/migrations/001.sql']);
    await expect(land(false)).resolves.toMatchObject({ prNumber: 77 });
    expect(holder.mergeAllowed).toBe(true);
  });
});
