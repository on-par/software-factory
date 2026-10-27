// packages/cli/src/cli/land-parent-coverage.test.ts — land and waitForMerge refresh parent coverage after a merge (#3108)

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openPrFixture } from './__fixtures__/open-pr.js';
import { type CliDeps, main } from './index.js';
import { waitForMerge } from './land.js';

const fakeConfig: any = {
  merge: { auto: false, comment: '' },
  ci: { skip: false, comment: '' },
  filing: {
    enabled: true,
    excludeReasons: [],
    repeatThreshold: 3,
    maxPerRun: 5,
    maxPerDay: 20,
    selfFixLabel: 'no-auto-merge',
    bugLabels: ['bug'],
    sensitivePaths: [],
  },
};

describe('waitForMerge parent coverage (#3108)', () => {
  it('refreshes the parent coverage once when a human merged the child', async () => {
    const refreshParentCoverage = vi.fn(async () => null);
    const events: any[] = [];
    await waitForMerge(7, 'ship-it/7-x', '/repo', 'o/r', { events: '/e', stop: '/STOP' } as any, {
      createOctokit: () => ({}) as any,
      pathExists: () => false,
      loadConfig: () => fakeConfig,
      checkMerged: async () => true,
      refreshParentCoverage,
      emitEvent: (_f: string, type: string, _i: string | number, msg: string) => events.push([type, msg]),
    });
    expect(refreshParentCoverage).toHaveBeenCalledTimes(1);
    expect(refreshParentCoverage).toHaveBeenCalledWith(expect.objectContaining({ repo: 'o/r', childIssue: 7 }));
    expect(events).toContainEqual(['landed', 'PR merged']);
  });
});

describe('land refreshes parent coverage after the merge (#3108)', () => {
  const tmp = createTempDirs();
  const childBody = 'Decomposed from #40 by the factory size gate.\nCovers parent criteria: P1\n';
  const ghRepo = 'on-par/software-factory';
  let repoRoot = '';
  let octokit: any;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    repoRoot = tmp.makeSync('factory-cli-');
    mkdirSync(join(repoRoot, '.git', 'info'), { recursive: true });
    mkdirSync(join(repoRoot, '.factory', 'state', 'plans'), { recursive: true });
    process.env.GH_TOKEN = 'test-token';
    delete process.env.GITHUB_TOKEN;
    octokit = {
      rest: {
        issues: {
          get: vi.fn(async ({ issue_number }: any) => ({
            data:
              issue_number === 40
                ? { title: 'Parent', body: '## Acceptance criteria\n- [ ] one\n- [ ] two\n' }
                : { title: 'Fix the bug', body: childBody },
          })),
          listForRepo: vi.fn(async () => ({ data: [] })),
          listLabelsOnIssue: vi.fn(async () => ({ data: [] })),
          listComments: vi.fn(async () => ({ data: [] })),
          createComment: vi.fn(async () => ({ data: { id: 1 } })),
        },
        users: { getAuthenticated: vi.fn(async () => ({ data: { id: 7 } })) },
        pulls: {
          list: vi.fn(async ({ state, head }: any) => ({ data: state === 'open' ? [openPrFixture(head)] : [] })),
          get: vi.fn(async () => ({ data: { head: { sha: 'abc123' } } })),
          merge: vi.fn(async () => ({})),
        },
        git: { deleteRef: vi.fn(async () => ({})) },
        checks: { listForRef: vi.fn(async () => ({ data: { check_runs: [] } })) },
        search: { issuesAndPullRequests: vi.fn(async () => ({ data: { items: [] } })) },
      },
      request: vi.fn(async () => ({
        data: [{ number: 5, body: childBody, state: 'closed', state_reason: 'completed' }],
      })),
      graphql: vi.fn(async (query: string) =>
        query.trimStart().startsWith('query')
          ? { repository: { pullRequest: { id: 'PR_ID', isDraft: false, mergeStateStatus: 'CLEAN' } } }
          : {},
      ),
    };
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    await tmp.cleanup();
    logSpy.mockRestore();
    process.exitCode = undefined;
  });

  const runLand = async (): Promise<void> => {
    const deps: Partial<CliDeps> = {
      loadModelsConfig: () => ({ models: {}, tiers: {} }) as never,
      loadRoutesConfig: () => ({}) as never,
      loadFactoryConfigForRepo: () =>
        ({
          merge: { auto: false, comment: '' },
          worktree: { parent: '../', gcTtlDays: 7, autoGcOnRun: false },
          sandbox: { enabled: true, network: { allow: [] }, resources: { cpuMs: 300_000, memMb: 4096 } },
          sweep: { loopIntervalSeconds: 300, staleThresholdMultiplier: 2 },
          filing: { selfFixLabel: 'no-auto-merge', enabled: false },
        }) as never,
      resolveTimeouts: () => ({ plan: 1, build: 1, check: 1, approval: 1, tests: 1, compile: 1 }),
      resolveSkipCI: () => false,
      getConstitutionsDir: vi.fn(() => ''),
      resolveEffectiveModelPins: vi.fn(() => ({ sources: {} })) as never,
      setupWorktree: vi.fn(async () => undefined as never),
      cleanupWorktree: vi.fn(async () => {}),
      gitFetch: vi.fn(async () => {}),
      watchChecks: vi.fn(async () => 'success') as never,
      exec: vi.fn(async (cmd: string) => ({
        stdout: cmd.includes('rev-parse') ? repoRoot : cmd.includes('gh repo view') ? ghRepo : '',
        stderr: '',
      })),
      execSync: vi.fn(() => {
        throw new Error('no cli available');
      }),
      octokit: () => octokit,
    };
    process.argv = ['node', 'factory', 'land', '5'];
    await main(['node', 'factory', 'land', '5'], deps);
  };

  it('writes the parent coverage comment after squash-merging a decomposed child', async () => {
    await runLand();
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 40, body: expect.stringContaining('**1/2**') }),
    );
  });

  it('a coverage refresh failure does not fail the land', async () => {
    octokit.request = vi.fn(async () => {
      throw new Error('sub_issues down');
    });
    await runLand();
    expect(process.exitCode).toBeUndefined();
    expect(logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n')).toContain('Landed PR #77');
  });
});
