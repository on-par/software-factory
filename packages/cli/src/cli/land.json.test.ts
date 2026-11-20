import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultOctokit } from './__fixtures__/land-octokit.js';
import { openPrFixture } from './__fixtures__/open-pr.js';
import { type CliDeps, cmdLand as cliCmdLand, main } from './index.js';
import { landResultJsonSchema } from './land-result-contract.js';

const h = {
  repoRoot: '',
  octokit: {} as any,
  factoryConfig: {} as any,
};

let logSpy: any, errSpy: any;
let logs: string[] = [];
let errors: string[] = [];
let merges = 0;
let snapshotQueries = 0;
const savedEnv: Record<string, string | undefined> = {};
const tmp = createTempDirs();

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

const inertGitOps: Pick<CliDeps, 'setupWorktree' | 'cleanupWorktree' | 'gitFetch'> = {
  setupWorktree: vi.fn(async () => undefined as never),
  cleanupWorktree: vi.fn(async () => undefined),
  gitFetch: async () => {},
};

function makeInternalFakes() {
  return {
    watchChecks: vi.fn(async () => 'success') as any,
    exec: vi.fn(async (cmd: string) => ({
      stdout: cmd.includes('rev-parse') ? h.repoRoot : cmd.includes('gh repo view') ? 'on-par/software-factory' : '',
      stderr: '',
    })),
    execSync: vi.fn((): string => {
      throw new Error('no cli available');
    }),
    octokit: () => h.octokit,
  } satisfies Pick<CliDeps, 'watchChecks' | 'exec' | 'execSync' | 'octokit'>;
}
let ops = makeInternalFakes();

function cmdLand(...[issueNum, opts, deps]: Parameters<typeof cliCmdLand>) {
  return cliCmdLand(issueNum, opts, { ...inertConfigLoaders, ...inertGitOps, ...ops, ...deps });
}

async function runMain(...args: string[]) {
  process.argv = ['node', 'factory', ...args];
  await main(['node', 'factory', ...args], { ...inertConfigLoaders, ...inertGitOps, ...ops });
  const code = process.exitCode as number | undefined;
  process.exitCode = undefined;
  return code;
}

const ROLLUP = [
  { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: null },
  { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' },
  { __typename: 'StatusContext', context: 'ci/legacy', state: 'PENDING' },
];

function installGraphql(mergeStateStatus = 'CLEAN') {
  h.octokit.graphql = vi.fn(async (query: string) => {
    if (query.includes('LandResultSnapshot')) {
      snapshotQueries += 1;
      return {
        repository: {
          pullRequest: {
            headRefOid: 'deadbeef',
            mergeable: 'MERGEABLE',
            commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: ROLLUP } } } }] },
          },
        },
      };
    }
    return query.trimStart().startsWith('query')
      ? { repository: { pullRequest: { id: 'PR_ID', isDraft: false, mergeStateStatus } } }
      : {};
  });
}

const outcomeLines = () => logs.filter((line) => /^[✅⏸]/u.test(line));

const lastResult = () => landResultJsonSchema.parse(JSON.parse(logs[logs.length - 1]));

beforeEach(() => {
  ops = makeInternalFakes();
  h.repoRoot = tmp.makeSync('factory-cli-');
  mkdirSync(join(h.repoRoot, '.git', 'info'), { recursive: true });
  mkdirSync(join(h.repoRoot, '.factory', 'state', 'plans'), { recursive: true });
  h.octokit = defaultOctokit();
  merges = 0;
  snapshotQueries = 0;
  logs = [];
  errors = [];
  const merge = h.octokit.rest.pulls.merge;
  h.octokit.rest.pulls.merge = async (a: unknown) => {
    merges += 1;
    return merge(a);
  };
  installGraphql();
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
  logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
  errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.join(' ')));
});

afterEach(async () => {
  await tmp.cleanup();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.exitCode = undefined;
  logSpy.mockRestore();
  errSpy.mockRestore();
  vi.clearAllMocks();
});

describe('factory land --json', () => {
  it('prints a merged result line on a successful merge', async () => {
    await expect(cmdLand(5, { json: true })).resolves.toBeUndefined();
    expect(merges).toBe(1);
    expect(lastResult()).toMatchObject({ result: 'merged', pr: 77, pending: [], headSha: 'deadbeef' });
  });

  it('prints a checks_pending result line when CI never reaches a green verdict', async () => {
    ops.watchChecks.mockResolvedValueOnce('timeout');
    await expect(cmdLand(5, { json: true })).rejects.toMatchObject({ code: 75 });
    expect(lastResult()).toMatchObject({ result: 'checks_pending', pending: ['ci/legacy', 'e2e'] });
  });

  it('exits 75 when CI never reaches a green verdict', async () => {
    ops.watchChecks.mockResolvedValueOnce('timeout');
    await expect(cmdLand(5)).rejects.toMatchObject({ code: 75 });
    expect(logs.join('\n')).toContain('left open, not merged');
    expect(merges).toBe(0);
  });

  it('main sets exit code 75 without printing an error line', async () => {
    ops.watchChecks.mockResolvedValueOnce('timeout');
    expect(await runMain('land', '5')).toBe(75);
    expect(errors.filter((line) => line !== '')).toEqual([]);
  });

  it('prints a checks_failed result line with failed check names', async () => {
    ops.watchChecks.mockResolvedValueOnce('failure');
    await expect(cmdLand(5, { json: true })).resolves.toBeUndefined();
    expect(merges).toBe(0);
    expect(lastResult()).toMatchObject({ result: 'checks_failed', failed: ['unit'] });
  });

  it('prints a conflicting result line on a land conflict', async () => {
    installGraphql('DIRTY');
    await expect(cmdLand(5, { json: true })).rejects.toMatchObject({ code: 3 });
    expect(lastResult()).toMatchObject({ result: 'conflicting', pr: 77 });
  });

  it('prints a closed result line when the PR is already closed', async () => {
    h.octokit.rest.pulls.list = vi.fn(async ({ state, head }: { state: string; head: string }) => ({
      data: state === 'all' ? [{ ...openPrFixture(head), number: 31, merged_at: null }] : [],
    }));
    await expect(cmdLand(5, { json: true })).rejects.toMatchObject({ code: 1 });
    expect(lastResult()).toMatchObject({ result: 'closed', pr: 31, pending: [] });
  });

  it('prints no JSON line when no PR exists at all', async () => {
    h.octokit.rest.pulls.list = vi.fn(async () => ({ data: [] }));
    await expect(cmdLand(5, { json: true })).rejects.toMatchObject({ code: 1 });
    expect(logs.some((line) => line.startsWith('{'))).toBe(false);
  });

  it('keeps human output unchanged and reads no snapshot without --json', async () => {
    await cmdLand(5);
    expect(outcomeLines()).toEqual(['✅ Landed PR #77 for issue #5']);
    logs = [];
    ops.watchChecks.mockResolvedValueOnce('failure');
    await cmdLand(5);
    expect(outcomeLines()).toEqual(['⏸ PR #77 for issue #5 has a failing CI check — left open, not merged']);
    logs = [];
    ops.watchChecks.mockResolvedValueOnce('timeout');
    await expect(cmdLand(5)).rejects.toMatchObject({ code: 75 });
    expect(outcomeLines()).toEqual([
      '⏸ PR #77 for issue #5 — CI never reached a green verdict — left open, not merged',
    ]);
    expect(snapshotQueries).toBe(0);
    expect(logs.some((line) => line.startsWith('{'))).toBe(false);
  });
});
