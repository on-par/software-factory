import { describe, expect, it, vi } from 'vitest';

import { getFactoryPaths, type FactoryConfig, type SandboxPolicy } from '@on-par/factory-core';
import { renderSlicePlanComment, withSliceState, type SlicePlan } from '@on-par/factory-core/internal';
import './index.js';
import {
  buildRunRequest,
  findSliceIndex,
  finishOutcome,
  logSandboxPolicy,
  type RunRequestInput,
} from './ship-steps.js';

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

it('finishOutcome returns the branch without throwing for a stack-wait release (#3367)', () => {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const branch = finishOutcome({
      outcome: {
        state: 'released',
        reason: 'stack-wait',
        branch: 'factory/9-slice-2',
        reworkRounds: 0,
        prNumber: 101,
        slice: { index: 1, count: 3 },
      },
      opts: {},
      paths: getFactoryPaths('/tmp/primary', '/tmp/relocated-factory'),
      issueNum: 9,
      worktree: '/tmp/wt',
      terminalMessage: undefined,
      log: () => {},
    });
    expect(branch).toBe('factory/9-slice-2');
    expect(spy.mock.calls.join('\n')).toContain('waiting for approval or merge of slice 1/3 PR #101');
  } finally {
    spy.mockRestore();
  }
});

it('findSliceIndex in stack mode returns the lowest pending slice (#3367)', async () => {
  const story = {
    schemaVersion: 1,
    kind: 'story',
    filesLikelyTouched: [],
    labels: [],
    title: 'Story',
    role: 'operator',
    want: 'thing works',
    soThat: 'value',
    problemStatement: 'Problem',
    inScope: ['Scope'],
    outOfScope: ['Persistent storage'],
    acceptanceCriteria: [{ name: 'ac', given: [], when: ['run'], then: ['works'] }],
    verification: [{ command: 'npm test', passWhen: 'passes' }],
    tracesTo: ['INT-PROBLEM-01'],
  } as never;
  let plan: SlicePlan = {
    issue: 9,
    slices: [1, 2, 3].map((n) => ({ index: n, title: `S${n}`, story, state: 'pending' as const })),
  };
  plan = withSliceState(plan, 1, 'pr-open', 50, 'factory/9-slice-1');
  const octokit = {
    rest: {
      users: { getAuthenticated: async () => ({ data: { id: 7 } }) },
      issues: {
        listComments: async () => ({ data: [{ id: 1, user: { id: 7 }, body: renderSlicePlanComment(plan) }] }),
      },
    },
  } as never;
  const work = {
    id: 'github-issue:o/r#9',
    kind: 'github-issue',
    title: 't',
    brief: 'b',
    acceptanceCriteria: [],
  } as never;
  const args = { ctx: undefined, work, octokit, ghRepo: 'o/r', issueNum: 9 };
  expect(await findSliceIndex({ ...args, sizeGateMode: 'stack' })).toBe(2);
  expect(await findSliceIndex({ ...args, sizeGateMode: 'slice' })).toBe(1);
});

describe('logSandboxPolicy egress enforcement (#2215)', () => {
  const base: SandboxPolicy = {
    runtime: 'sandbox-exec',
    worktree: '/tmp/worktree',
    writablePaths: [],
    writableFilePrefixes: [],
    allowHosts: ['api.anthropic.com'],
    cpuMs: 300_000,
    memMb: 4096,
  };
  const degraded = (log: ReturnType<typeof vi.fn>): boolean =>
    log.mock.calls.some(([type]) => type === 'sandbox-degraded');

  it('logs no sandbox-degraded for sandbox-exec in enforce mode', () => {
    const log = vi.fn();
    const policy = { ...base, networkMode: 'enforce' as const };
    expect(logSandboxPolicy({}, policy, log)).toBe(policy);
    expect(degraded(log)).toBe(false);
  });

  it('still logs sandbox-degraded for sandbox-exec in report mode and for firejail in enforce mode', () => {
    const report = vi.fn();
    logSandboxPolicy({}, { ...base, networkMode: 'report' }, report);
    expect(degraded(report)).toBe(true);
    const firejail = vi.fn();
    logSandboxPolicy({}, { ...base, runtime: 'firejail', networkMode: 'enforce' }, firejail);
    expect(degraded(firejail)).toBe(true);
  });
});
