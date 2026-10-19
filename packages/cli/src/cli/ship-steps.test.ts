import { expect, it, vi } from 'vitest';

import { getFactoryPaths, type FactoryConfig, type SandboxPolicy } from '@on-par/factory-core';
import './index.js';
import { buildRunRequest, logSandboxPolicy, type RunRequestInput } from './ship-steps.js';

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
