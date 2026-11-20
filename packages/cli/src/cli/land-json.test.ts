import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultOctokit } from './__fixtures__/land-octokit.js';
import { openPrFixture } from './__fixtures__/open-pr.js';
import { type CliDeps, cmdLand as cliCmdLand, main } from './index.js';
import { landResultJsonSchema } from './land-result-contract.js';

const h = { repoRoot: '', ghRepo: 'on-par/software-factory', octokit: {} as any, factoryConfig: {} as any };
const tmp = createTempDirs();
let logs: string[] = [];
let errs: string[] = [];
let logSpy: any, errSpy: any;

const loaders = {
  loadModelsConfig: () => ({ models: {}, tiers: {} }) as never,
  loadRoutesConfig: () => ({}) as never,
  loadFactoryConfigForRepo: () => h.factoryConfig,
  resolveTimeouts: () => ({ plan: 1, build: 1, check: 1, approval: 1, tests: 1, compile: 1 }),
  resolveSkipCI: () => false,
  getConstitutionsDir: vi.fn(() => ''),
  resolveEffectiveModelPins: vi.fn(() => ({ sources: {} })) as never,
};
const gitOps = {
  setupWorktree: vi.fn(async () => undefined as never),
  cleanupWorktree: vi.fn(async () => undefined as never),
  gitFetch: vi.fn(async () => undefined),
};
let watchChecks = vi.fn(async () => 'success') as any;
const internal = () => ({
  watchChecks,
  exec: vi.fn(async (cmd: string) => ({
    stdout: cmd.includes('rev-parse') ? h.repoRoot : cmd.includes('gh repo view') ? h.ghRepo : '',
    stderr: '',
  })),
  execSync: vi.fn(() => {
    throw new Error('no cli available');
  }),
  octokit: () => h.octokit,
});
const deps = (): Partial<CliDeps> => ({ ...loaders, ...gitOps, ...internal() }) as never;
const land = (json?: boolean) => cliCmdLand(5, { json }, deps());
const lastLine = () => logs[logs.length - 1] as string;
const parsed = () => landResultJsonSchema.parse(JSON.parse(lastLine()));

beforeEach(() => {
  h.repoRoot = tmp.makeSync('factory-land-json-');
  mkdirSync(join(h.repoRoot, '.git', 'info'), { recursive: true });
  mkdirSync(join(h.repoRoot, '.factory', 'state', 'plans'), { recursive: true });
  h.octokit = defaultOctokit();
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
  watchChecks = vi.fn(async () => 'success');
  logs = [];
  errs = [];
  process.env.GH_TOKEN = 'test-token';
  process.exitCode = undefined;
  logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
  errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errs.push(a.join(' ')));
});

afterEach(async () => {
  await tmp.cleanup();
  process.exitCode = undefined;
  logSpy.mockRestore();
  errSpy.mockRestore();
});

const conflict = () => {
  h.octokit.graphql = vi.fn(async (query: string) =>
    query.trimStart().startsWith('query')
      ? { repository: { pullRequest: { id: 'PR_ID', isDraft: false, mergeStateStatus: 'DIRTY' } } }
      : {},
  );
};

describe('factory land --json', () => {
  it('prints a merged result line and exits 0', async () => {
    await expect(land(true)).resolves.toBeUndefined();
    expect(parsed()).toMatchObject({ result: 'merged', pr: 77 });
  });

  it('prints a checks_pending result line with pending check names and exits 75 on a CI-watch timeout', async () => {
    watchChecks.mockResolvedValueOnce('timeout');
    h.octokit.rest.checks.listForRef = vi.fn(async () => ({
      data: { check_runs: [{ name: 'build', status: 'in_progress', conclusion: null }] },
    }));
    await expect(land(true)).rejects.toMatchObject({ code: 75, message: '' });
    expect(parsed()).toMatchObject({ result: 'checks_pending', pr: 77, pending: ['build'] });
  });

  it('prints a checks_failed result line with failed check names and keeps exit 0', async () => {
    watchChecks.mockResolvedValueOnce('failure');
    h.octokit.rest.checks.listForRef = vi.fn(async () => ({
      data: { check_runs: [{ name: 'e2e', status: 'completed', conclusion: 'failure' }] },
    }));
    await expect(land(true)).resolves.toBeUndefined();
    expect(parsed()).toMatchObject({ result: 'checks_failed', pr: 77, failed: ['e2e'] });
  });

  it('prints a conflicting result line and keeps exit 3', async () => {
    conflict();
    await expect(land(true)).rejects.toMatchObject({ code: 3 });
    expect(parsed()).toMatchObject({ result: 'conflicting', pr: 77 });
  });

  it('prints a closed result line and keeps exit 1 when the branch PR is closed', async () => {
    h.octokit.rest.pulls.list = vi.fn(async ({ state, head }: any) => ({
      data: state === 'open' ? [] : [{ ...openPrFixture(head), number: 61, merged_at: null }],
    }));
    await expect(land(true)).rejects.toMatchObject({ code: 1 });
    expect(parsed()).toMatchObject({ result: 'closed', pr: 61 });
  });

  it('prints no JSON line and unchanged human lines without --json', async () => {
    await land();
    expect(logs.some((l) => l.startsWith('{'))).toBe(false);
    expect(logs.join('\n')).toContain('Landed PR #77');

    logs = [];
    watchChecks.mockResolvedValueOnce('timeout');
    await expect(land()).rejects.toMatchObject({ code: 75 });
    expect(logs.some((l) => l.startsWith('{'))).toBe(false);
    expect(logs.join('\n')).toContain('CI never reached a green verdict — left open, not merged');

    logs = [];
    watchChecks.mockResolvedValueOnce('failure');
    await land();
    expect(logs.some((l) => l.startsWith('{'))).toBe(false);
    expect(logs.join('\n')).toContain('has a failing CI check — left open, not merged');

    logs = [];
    conflict();
    await expect(land()).rejects.toMatchObject({ code: 3 });
    expect(logs.some((l) => l.startsWith('{'))).toBe(false);
  });

  it('main returns exit code 75 with nothing on stderr when checks are still pending', async () => {
    watchChecks.mockResolvedValueOnce('timeout');
    await main(['node', 'factory', 'land', '5'], deps());
    expect(process.exitCode).toBe(75);
    expect(errs).toEqual([]);
  });
});
