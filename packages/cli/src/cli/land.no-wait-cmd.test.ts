import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadFactoryConfig } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultOctokit } from './__fixtures__/land-octokit.js';
import { main } from './index.js';
import { landJsonSchema } from './land-contract.js';

const HEAD = 'abc123';
const SETTLE_MS = 2_000;

type CheckRun = { name: string; status: string; conclusion: string | null };
type WatchMode = 'held' | 'success';
type Scenario = { runs: CheckRun[]; watch?: WatchMode; waitForCi?: boolean };
type Outcome = {
  settled: boolean;
  code: number;
  lines: string[];
  merges: string[];
  watched: string[];
};

const greenCi: CheckRun = { name: 'ci', status: 'completed', conclusion: 'success' };
const runningCi: CheckRun = { name: 'ci', status: 'in_progress', conclusion: null };
const failingCi: CheckRun = { name: 'ci', status: 'completed', conclusion: 'failure' };

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

const tmp = createTempDirs();
const printed: string[] = [];
const written: string[] = [];
const heldWatches: Array<() => void> = [];
const inflight: Array<Promise<unknown>> = [];
let repoRoot = '';

beforeEach(() => {
  repoRoot = tmp.makeSync('factory-land-no-wait-cmd-');
  for (const dir of [join('.git', 'info'), join('.factory', 'state', 'plans')]) {
    mkdirSync(join(repoRoot, dir), { recursive: true });
  }
  printed.length = 0;
  written.length = 0;
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => void printed.push(parts.join(' ')));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never);
  const cleared = ['FACTORY_LOCAL_ONLY', 'FACTORY_MERGE', 'FACTORY_MERGE_ADMIN', 'FACTORY_SKIP_CI'];
  for (const key of [...cleared, 'FACTORY_RUN_CONFIG_JSON', 'GITHUB_TOKEN']) vi.stubEnv(key, undefined);
  vi.stubEnv('GH_TOKEN', 'test-token');
  process.exitCode = undefined;
});

afterEach(async () => {
  for (const release of heldWatches.splice(0)) release();
  await Promise.allSettled(inflight.splice(0));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  await tmp.cleanup();
});

function scenarioOctokit(scenario: Scenario, merges: string[]) {
  const base = defaultOctokit();
  const pull = {
    number: 77,
    state: 'open',
    body: '',
    head: { sha: HEAD, ref: 'factory/5-fix-the-bug' },
    base: { ref: 'main' },
    mergeable: true,
    mergeable_state: 'clean',
    merge_commit_sha: 'merged',
  };
  const checkRuns = scenario.runs.map((run, index) => ({ id: index + 1, head_sha: HEAD, ...run }));
  return {
    ...base,
    rest: {
      ...base.rest,
      pulls: {
        ...base.rest.pulls,
        get: async () => ({ data: pull }),
        merge: async (args: { sha?: string }) => {
          merges.push(args.sha ?? 'unpinned');
          return { data: { merged: true } };
        },
      },
      repos: {
        ...base.rest.repos,
        getStatusChecksProtection: async () => ({ data: { contexts: ['ci'], checks: [] } }),
        compareCommitsWithBasehead: async () => ({ data: { behind_by: 0, ahead_by: 1 } }),
        getCombinedStatusForRef: async () => ({ data: { total_count: 0, statuses: [], sha: HEAD } }),
        listCommitStatusesForRef: async () => ({ data: [] }),
      },
      checks: {
        listForRef: async (args: { ref: string }) => {
          const runs =
            args.ref === HEAD
              ? checkRuns
              : [{ id: 99, head_sha: args.ref, name: 'ci', status: 'completed', conclusion: 'success' }];
          return { data: { total_count: runs.length, check_runs: runs } };
        },
      },
    },
  };
}

function watchFor(mode: WatchMode, watched: string[]) {
  return (opts: { ref: string }) => {
    watched.push(opts.ref);
    if (mode === 'success') return Promise.resolve('success' as const);
    return new Promise<'timeout'>((resolve) => void heldWatches.push(() => resolve('timeout')));
  };
}

function settleWithin<T>(work: Promise<T>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([work.then(() => true), deadline]).finally(() => clearTimeout(timer));
}

async function land(scenario: Scenario, flags: string[] = [], ms = SETTLE_MS): Promise<Outcome> {
  const merges: string[] = [];
  const watched: string[] = [];
  const octokit = scenarioOctokit(scenario, merges);
  const defaults = loadFactoryConfig();
  const landSection = scenario.waitForCi === undefined ? {} : { land: { waitForCi: scenario.waitForCi } };
  const config = { ...defaults, sandbox: { ...defaults.sandbox, enabled: false }, ...landSection };
  let exitCode: number | undefined;
  const exec = async (cmd: string) => {
    if (cmd.startsWith('gh repo view')) return { stdout: 'on-par/software-factory', stderr: '' };
    if (cmd.includes('gh pr merge')) merges.push(cmd.includes(HEAD) ? HEAD : 'unpinned');
    return { stdout: cmd.includes('rev-parse') ? repoRoot : '', stderr: '' };
  };
  const noCli = (): never => {
    throw new Error('no cli available');
  };
  const run = main(['node', 'factory', 'land', '5', ...flags], {
    loadFactoryConfigForRepo: () => config,
    watchChecks: watchFor(scenario.watch ?? 'held', watched) as never,
    resolveSkipCI: () => false,
    gitFetch: async () => undefined,
    cleanupWorktree: async () => undefined,
    setupWorktree: async () => undefined as never,
    octokit: () => octokit as never,
    execSync: noCli,
    exec,
  }).catch((err: unknown) => {
    if (!(err instanceof ExitSignal)) throw err;
    exitCode = err.code;
  });
  inflight.push(run);
  const settled = await settleWithin(run, ms);
  const code = exitCode ?? (typeof process.exitCode === 'number' ? process.exitCode : 0);
  return { settled, code, lines: [...printed], merges, watched };
}

function finalJson(outcome: Outcome) {
  return landJsonSchema.parse(JSON.parse(outcome.lines.at(-1) ?? ''));
}

const jsonLines = (outcome: Outcome) => outcome.lines.filter((line) => line.startsWith('{'));

const pendingLine = {
  result: 'checks_pending',
  pr: 77,
  headSha: HEAD,
  pending: ['ci'],
  mergeable: 'MERGEABLE',
  schemaVersion: 1,
};

const mergedLine = { result: 'merged', pr: 77, headSha: HEAD, pending: [], mergeable: 'MERGEABLE', schemaVersion: 1 };

describe('factory land <issue> --no-wait (#4308)', () => {
  it('returns within seconds on pending checks, exits 75, prints checks_pending and leaves the PR unmerged', async () => {
    const outcome = await land({ runs: [runningCi] }, ['--no-wait']);
    expect(outcome.settled).toBe(true);
    expect(outcome.code).toBe(75);
    expect(finalJson(outcome)).toEqual(pendingLine);
    expect(outcome.merges).toEqual([]);
    expect(outcome.watched).toEqual([]);
  });

  it('prints exactly one checks_pending JSON line with --json as well', async () => {
    const outcome = await land({ runs: [runningCi] }, ['--no-wait', '--json']);
    expect(outcome.settled).toBe(true);
    expect(outcome.code).toBe(75);
    expect(jsonLines(outcome)).toHaveLength(1);
    expect(finalJson(outcome)).toEqual(pendingLine);
  });

  it('merges the verified head on green and mergeable, exits 0 and prints merged without --json', async () => {
    const outcome = await land({ runs: [greenCi] }, ['--no-wait']);
    expect(outcome.settled).toBe(true);
    expect(outcome.code).toBe(0);
    expect(outcome.merges).toEqual([HEAD]);
    expect(outcome.watched).toEqual([]);
    expect(outcome.lines.some((line) => line.includes('Landed PR #77 for issue #5'))).toBe(true);
    expect(finalJson(outcome)).toEqual(mergedLine);
  });

  it('reports a failing required check as checks_failed with the human line and exit 0, without merging', async () => {
    const outcome = await land({ runs: [failingCi] }, ['--no-wait']);
    expect(outcome.settled).toBe(true);
    expect(outcome.code).toBe(0);
    expect(outcome.merges).toEqual([]);
    expect(outcome.watched).toEqual([]);
    expect(outcome.lines.some((line) => line.includes('has a failing CI check — left open, not merged'))).toBe(true);
    expect(finalJson(outcome)).toMatchObject({ result: 'checks_failed', pr: 77, headSha: HEAD, failed: ['ci'] });
  });

  it('wins over land.waitForCi: true in the factory config', async () => {
    const outcome = await land({ runs: [runningCi], waitForCi: true }, ['--no-wait']);
    expect(outcome.settled).toBe(true);
    expect(outcome.code).toBe(75);
    expect(outcome.merges).toEqual([]);
    expect(outcome.watched).toEqual([]);
    expect(finalJson(outcome)).toEqual(pendingLine);
  });

  it('is described in the land help text', async () => {
    const outcome = await land({ runs: [] }, ['--help']);
    expect(outcome.code).toBe(0);
    expect(written.join('')).toMatch(/--no-wait\s+\S/);
  });
});

describe('land.waitForCi: false in the factory config (#4308)', () => {
  it('returns within seconds on pending checks with exit 75 and a checks_pending line, without the flag', async () => {
    const outcome = await land({ runs: [runningCi], waitForCi: false });
    expect(outcome.settled).toBe(true);
    expect(outcome.code).toBe(75);
    expect(outcome.merges).toEqual([]);
    expect(outcome.watched).toEqual([]);
    expect(finalJson(outcome)).toEqual(pendingLine);
  });

  it('merges a green, mergeable head once and prints merged without --json', async () => {
    const outcome = await land({ runs: [greenCi], waitForCi: false });
    expect(outcome.settled).toBe(true);
    expect(outcome.code).toBe(0);
    expect(outcome.merges).toEqual([HEAD]);
    expect(outcome.watched).toEqual([]);
    expect(finalJson(outcome)).toEqual(mergedLine);
  });
});

describe('factory land <issue> without --no-wait keeps waiting on CI (#4308)', () => {
  it('is still blocked on the CI watch while checks are pending and merges nothing', async () => {
    const outcome = await land({ runs: [runningCi] }, [], 500);
    expect(outcome.settled).toBe(false);
    expect(outcome.watched).toEqual([HEAD]);
    expect(outcome.merges).toEqual([]);
  });

  it('watches CI, then merges the watched head and prints no JSON line without --json', async () => {
    const outcome = await land({ runs: [greenCi], watch: 'success' });
    expect(outcome.settled).toBe(true);
    expect(outcome.code).toBe(0);
    expect(outcome.watched).toEqual([HEAD]);
    expect(outcome.merges).toEqual([HEAD]);
    expect(jsonLines(outcome)).toEqual([]);
  });

  it('keeps waiting when land.waitForCi is true', async () => {
    const outcome = await land({ runs: [greenCi], watch: 'success', waitForCi: true });
    expect(outcome.settled).toBe(true);
    expect(outcome.code).toBe(0);
    expect(outcome.watched).toEqual([HEAD]);
    expect(outcome.merges).toEqual([HEAD]);
  });
});
