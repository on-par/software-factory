import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import { getFactoryPaths, type FactoryConfig, type SandboxPolicy, type WorkRequest } from '@on-par/factory-core';
import { renderSlicePlanComment, withSliceState, type SlicePlan } from '@on-par/factory-core/internal';
import { IssueSkippedError, LaneParkError } from './index.js';
import { buildRunRequest, findSliceIndex, logSandboxPolicy, type RunRequestInput } from './ship-steps.js';

it('passes the resolved factory state and primary git directory to Codex', () => {
  const repoRoot = '/tmp/primary';
  const paths = getFactoryPaths(repoRoot, '/tmp/relocated-factory');
  const input = {
    issueNum: 3249,
    ghRepo: 'on-par/software-factory',
    repoRoot,
    branch: 'issue-3249',
    specPath: `${paths.plans}/issue-3249.md`,
    work: {
      id: 'github-issue:on-par/software-factory#3249',
      kind: 'github-issue',
      title: 'Fix',
      brief: 'Fix',
      acceptanceCriteria: [],
    },
    product: undefined,
    runStartedAt: '2026-10-19T00:00:00Z',
    lane: undefined,
    opts: {},
    autoRework: false,
    planApprovalEnabled: false,
    factoryConfig: {} as FactoryConfig,
    repoConfig: { version: 2 },
    classifierPolicy: { enabled: false },
    loaders: { resolveSkipCI: () => false },
    efficiency: { maxReworkRounds: 0, fastPath: false } as RunRequestInput['efficiency'],
    sizeGateMode: undefined,
    maxSlices: undefined,
    timeouts: { plan: 1, build: 1, check: 1, approval: 1, tests: 1 },
    modelPins: { sources: {} },
    codexOff: false,
    failoverSettings: { enabled: false, cooldownMs: 1, fallbackModel: '' },
    activeSandboxPolicy: undefined,
    processGroupGraceMs: 1,
    paths,
  } satisfies RunRequestInput;
  const request = buildRunRequest(input);
  expect(request.codexWorkspacePaths).toEqual({
    primaryRepoRoot: repoRoot,
    writableRoots: [paths.state, `${repoRoot}/.git`],
  });
  expect(request.specPath.startsWith(`${paths.state}/plans/`)).toBe(true);
});

it('retains runtime none for harnesses while --no-sandbox still disables it', () => {
  const policy: SandboxPolicy = {
    runtime: 'none',
    worktree: '/tmp/worktree',
    writablePaths: [],
    writableFilePrefixes: [],
    allowHosts: [],
    cpuMs: 300_000,
    memMb: 4096,
  };
  const log = vi.fn();
  expect(logSandboxPolicy({}, policy, log)).toBe(policy);
  expect(log).toHaveBeenCalledWith(
    'sandbox',
    'outer sandbox off; harness sandbox in use (codex --sandbox workspace-write; harnesses without their own sandbox run unwrapped)',
  );
  expect(log.mock.calls.flat().join(' ')).not.toContain('running uncontained');
  const consoleError = vi.spyOn(console, 'error').mockImplementationOnce(() => {});
  expect(logSandboxPolicy({ sandbox: false }, policy, vi.fn())).toBeUndefined();
  consoleError.mockRestore();
});

describe('findSliceIndex stack mode', () => {
  const story = (n: number) =>
    ({
      kind: 'story',
      schemaVersion: 1,
      title: `Story ${n}`,
      role: 'a maintainer',
      want: 'a slice',
      soThat: 'it ships',
      problemStatement: 'too big',
      inScope: ['one thing'],
      outOfScope: [],
      acceptanceCriteria: [{ name: 'works', given: [], when: ['it runs'], then: ['it passes'] }],
      verification: [{ command: 'npm test', passWhen: 'green' }],
      filesLikelyTouched: [],
      labels: [],
      tracesTo: [],
    }) as never;
  const fresh: SlicePlan = {
    issue: 9,
    slices: [1, 2].map((n) => ({ index: n, title: `S${n}`, story: story(n), state: 'pending' as const })),
  };
  const open = withSliceState(fresh, 1, 'pr-open', 101, 'factory/9-slice-1');
  const work: WorkRequest = {
    id: 'github-issue:o/r#9',
    kind: 'github-issue',
    title: 't',
    brief: 'b',
    acceptanceCriteria: [],
  };

  function stub(
    plan: SlicePlan,
    pull: { merged?: boolean; state?: string },
    reviews: unknown[] = [],
    pullsThrow = false,
  ) {
    const updateComment = vi.fn(async (_a: { body: string }) => ({ data: {} }));
    const octokit = {
      rest: {
        users: { getAuthenticated: async () => ({ data: { id: 7 } }) },
        issues: {
          listComments: async () => ({ data: [{ id: 99, user: { id: 7 }, body: renderSlicePlanComment(plan) }] }),
          updateComment,
          createComment: updateComment,
        },
        pulls: {
          get: async () => {
            if (pullsThrow) throw new Error('github down');
            return { data: { merged: false, state: 'open', head: { sha: 'h' }, ...pull } };
          },
          listReviews: async () => ({ data: reviews }),
        },
      },
    } as never;
    return { octokit, updateComment };
  }
  const run = (octokit: Octokit, sizeGateMode: 'stack' | 'slice' = 'stack', log?: (msg: string) => void) =>
    findSliceIndex({ sizeGateMode, work, octokit, ghRepo: 'o/r', issueNum: 9, log });
  const approval = [{ user: { id: 3 }, state: 'APPROVED', commit_id: 'h' }];

  it("picks slice 2 when slice 1's PR is approved (#3367)", async () => {
    const { octokit, updateComment } = stub(open, {}, approval);
    expect(await run(octokit)).toBe(2);
    expect(updateComment).not.toHaveBeenCalled();
  });

  it('returns 2 and records slice 1 merged when the PR is merged', async () => {
    const { octokit, updateComment } = stub(open, { merged: true, state: 'closed' });
    expect(await run(octokit)).toBe(2);
    expect(updateComment.mock.calls[0]![0].body).toContain('merged (#101)');
  });

  it('returns slice 1 for a fresh plan without reading the gate', async () => {
    const { octokit } = stub(fresh, {}, [], true);
    expect(await run(octokit)).toBe(1);
  });

  it("releases with stack-slice-waiting and writes the wait line when slice 1's PR is not approved (#3367)", async () => {
    const { octokit, updateComment } = stub(open, {});
    const log = vi.fn();
    const err = await run(octokit, 'stack', log).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(IssueSkippedError);
    expect((err as IssueSkippedError).reason).toBe('stack-slice-waiting');
    expect(updateComment.mock.calls[0]![0].body).toContain('waiting for approval or merge before slice 2');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain('PR #101');
  });

  it('notes changes requested in the wait message', async () => {
    const { octokit } = stub(open, {}, [{ user: { id: 3 }, state: 'CHANGES_REQUESTED', commit_id: 'h' }]);
    await expect(run(octokit)).rejects.toThrow('(changes requested)');
  });

  it('parks as LaneParkError when the gate reader fails', async () => {
    const { octokit } = stub(open, {}, [], true);
    await expect(run(octokit)).rejects.toBeInstanceOf(LaneParkError);
  });

  it('keeps currentSlice in slice mode', async () => {
    const { octokit } = stub(open, {});
    expect(await run(octokit, 'slice')).toBe(1);
  });
});
