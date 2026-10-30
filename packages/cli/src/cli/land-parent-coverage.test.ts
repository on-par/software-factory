// packages/cli/src/cli/land-parent-coverage.test.ts — land no longer touches the decomposed parent (#3834)

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openPrFixture } from './__fixtures__/open-pr.js';
import { type CliDeps, main } from './index.js';

describe('land leaves a decomposed parent alone (#3834)', () => {
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

  it('lands a child with a Covers parent criteria line without reading or writing the parent', async () => {
    await runLand();
    expect(logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n')).toContain('Landed PR #77');
    expect(process.exitCode).toBeUndefined();
    const parentCall = (call: unknown[]): boolean => (call[0] as { issue_number?: number }).issue_number === 40;
    expect(octokit.rest.issues.createComment.mock.calls.filter(parentCall)).toEqual([]);
    expect(octokit.rest.issues.get.mock.calls.filter(parentCall)).toEqual([]);
    expect(octokit.request).not.toHaveBeenCalled();
  });
});
