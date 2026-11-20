import { describe, expect, it } from 'vitest';

import './index.js';
import { CiFailedError, isCiNotGreen, LandConflictError, landOpenPullRequest } from './land-pr.js';

const HEAD = 'head-sha-4307';

type CheckRun = { id: number; name: string; status: string; conclusion: string | null };

type Scenario = {
  checks?: CheckRun[];
  mergeState?: string;
  mergeable?: boolean | null;
  behind?: boolean;
  protectedContexts?: string[];
  watchMode?: 'hang' | 'success';
  noWait?: boolean;
  waitForCi?: boolean;
  skipCI?: boolean;
};

type Flags = Pick<Scenario, 'noWait' | 'waitForCi'>;

const green = (name: string, id = 11): CheckRun => ({ id, name, status: 'completed', conclusion: 'success' });
const running = (name: string, status = 'in_progress', id = 12): CheckRun => ({ id, name, status, conclusion: null });

function setup(scenario: Scenario = {}) {
  const {
    checks = [green('ci')],
    mergeState = 'CLEAN',
    mergeable = true,
    behind = false,
    protectedContexts = ['ci'],
    watchMode = 'hang',
  } = scenario;
  const merges: Array<string | undefined> = [];
  const commands: string[] = [];
  const reruns: string[] = [];
  const watched: string[] = [];
  const landState = { id: 'PR_9', isDraft: false, mergeStateStatus: mergeState };
  const job = { conclusion: 'failure', run_id: 77, run_attempt: 1, head_sha: HEAD, runner_id: 0, steps: [] };
  const pull = {
    number: 9,
    state: 'open',
    body: '',
    head: { sha: HEAD, ref: 'factory/4307-x' },
    base: { ref: 'main' },
    mergeable,
    mergeable_state: mergeState.toLowerCase(),
  };
  const octokit: any = {
    graphql: async () => ({ repository: { pullRequest: landState } }),
    rest: {
      pulls: {
        get: async () => ({ data: pull }),
        merge: async (args: { sha?: string }) => {
          merges.push(args.sha);
          return { data: { merged: true } };
        },
      },
      checks: {
        listForRef: async (args: { ref: string }) => {
          const runs = args.ref === HEAD ? checks.map((c) => ({ ...c, head_sha: HEAD })) : [];
          return { data: { total_count: runs.length, check_runs: runs } };
        },
      },
      repos: {
        getStatusChecksProtection: async (args: { branch: string }) => {
          if (args.branch !== 'main' || protectedContexts.length === 0) {
            throw Object.assign(new Error('Not Found'), { status: 404 });
          }
          return { data: { contexts: protectedContexts, checks: [] } };
        },
        getBranchRules: async () => ({ data: [] }),
        getCombinedStatusForRef: async () => ({ data: { total_count: 0, statuses: [], sha: HEAD } }),
        compareCommitsWithBasehead: async () => ({ data: { behind_by: behind ? 1 : 0, ahead_by: 1 } }),
        listCommitStatusesForRef: async () => ({ data: [] }),
      },
      actions: { getJobForWorkflowRun: async () => ({ data: job }) },
      git: { deleteRef: async () => {} },
    },
  };
  const run = async (command: string) => {
    commands.push(command);
    if (command.startsWith('test -e')) return { stdout: 'no' };
    if (/^git (rev-parse --verify HEAD|merge-base)/.test(command)) return { stdout: 'b'.repeat(40) };
    if (command.startsWith('git merge --no-edit') && mergeState === 'DIRTY') throw new Error('CONFLICT');
    if (command.startsWith('git diff --name-only --diff-filter=U')) return { stdout: 'src/a.ts\0' };
    return { stdout: '' };
  };
  const watch = (opts: { ref: string }) => {
    watched.push(opts.ref);
    return watchMode === 'success' ? Promise.resolve('success' as const) : new Promise<never>(() => {});
  };
  const rerun = async (argv: readonly string[]) => {
    reruns.push(argv.join(' '));
    return { ok: true };
  };
  const land = () =>
    landOpenPullRequest({
      octokit,
      owner: 'on-par',
      repoName: 'software-factory',
      ghRepo: 'on-par/software-factory',
      repoRoot: '/repo',
      issue: 4307,
      branch: 'factory/4307-x',
      worktree: '/repo-factory-4307',
      prNumber: 9,
      log: () => {},
      run,
      pathExists: () => true,
      sleep: async () => {},
      adminMerge: false,
      watch: watch as any,
      rerun,
      withLock: (fn) => fn(),
      noWait: scenario.noWait,
      waitForCi: scenario.waitForCi,
      skipCI: scenario.skipCI,
    });
  return { merges, commands, reruns, watched, land };
}

type Settled = { settled: false } | { settled: true; error?: unknown };

async function within(promise: Promise<void>, ms = 2_000): Promise<Settled> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Settled>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms);
  });
  const outcome = promise.then(
    (): Settled => ({ settled: true }),
    (error: unknown): Settled => ({ settled: true, error }),
  );
  try {
    return await Promise.race([outcome, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function settledError(result: Settled): unknown {
  expect(result.settled).toBe(true);
  return result.settled ? result.error : undefined;
}

const pushes = (commands: string[]) => commands.filter((c) => c.startsWith('git push'));

describe('landOpenPullRequest with noWait: one read of the PR and its checks (#4307)', () => {
  it.each([
    { label: 'an in-progress required check', checks: [green('lint', 13), running('ci')] },
    { label: 'a queued required check', checks: [running('ci', 'queued')] },
    { label: 'a required check not reported yet', checks: [green('lint', 13)] },
  ])('$label exits at once as checks_pending and leaves the PR unchanged', async ({ checks }) => {
    const { merges, commands, reruns, watched, land } = setup({ checks, noWait: true });
    expect(isCiNotGreen(settledError(await within(land())))).toBe(true);
    expect(merges).toEqual([]);
    expect(commands).toEqual([]);
    expect(reruns).toEqual([]);
    expect(watched).toEqual([]);
  });

  it('unknown mergeability with green checks exits as checks_pending without merging', async () => {
    const { merges, commands, watched, land } = setup({ mergeState: 'UNKNOWN', mergeable: null, noWait: true });
    expect(isCiNotGreen(settledError(await within(land())))).toBe(true);
    expect(merges).toEqual([]);
    expect(commands).toEqual([]);
    expect(watched).toEqual([]);
  });

  it.each([
    { label: 'GitHub reports BEHIND', mergeState: 'BEHIND' },
    { label: 'GitHub reports CLEAN but the head lacks base commits', mergeState: 'CLEAN' },
  ])('a head that needs a sync ($label) is checks_pending, never synced or merged', async ({ mergeState }) => {
    const { merges, commands, watched, land } = setup({ mergeState, behind: true, noWait: true });
    expect(isCiNotGreen(settledError(await within(land())))).toBe(true);
    expect(pushes(commands)).toEqual([]);
    expect(commands).toEqual([]);
    expect(merges).toEqual([]);
    expect(watched).toEqual([]);
  });

  it('all required checks green on a mergeable PR merges at once, pinned to the head it read', async () => {
    const { merges, commands, reruns, watched, land } = setup({ noWait: true });
    expect(await within(land())).toEqual({ settled: true });
    expect(merges).toEqual([HEAD]);
    expect(commands).toEqual([]);
    expect(reruns).toEqual([]);
    expect(watched).toEqual([]);
  });

  it('uses the base branch required checks, so a pending non-required check does not hold the merge', async () => {
    const { merges, land } = setup({ checks: [green('ci'), running('preview')], noWait: true });
    expect(await within(land())).toEqual({ settled: true });
    expect(merges).toEqual([HEAD]);
  });

  it('without branch protection every check on the head counts, so a pending one is checks_pending', async () => {
    const checks = [green('ci'), running('preview')];
    const { merges, land } = setup({ checks, protectedContexts: [], noWait: true });
    expect(isCiNotGreen(settledError(await within(land())))).toBe(true);
    expect(merges).toEqual([]);
  });

  it('a failed required check is CiFailedError (checks_failed) and is never rerun', async () => {
    const failed: CheckRun = { id: 11, name: 'ci', status: 'completed', conclusion: 'failure' };
    const { merges, reruns, watched, land } = setup({ checks: [failed], noWait: true });
    const error = settledError(await within(land()));
    expect(error).toBeInstanceOf(CiFailedError);
    expect(isCiNotGreen(error)).toBe(false);
    expect(error).toMatchObject({ prNumber: 9, parkReason: 'ci-failed' });
    expect(reruns).toEqual([]);
    expect(merges).toEqual([]);
    expect(watched).toEqual([]);
  });

  it('a conflicting (DIRTY) PR is LandConflictError and is never pushed or merged', async () => {
    const { merges, commands, watched, land } = setup({ mergeState: 'DIRTY', mergeable: false, noWait: true });
    expect(settledError(await within(land()))).toBeInstanceOf(LandConflictError);
    expect(pushes(commands)).toEqual([]);
    expect(merges).toEqual([]);
    expect(watched).toEqual([]);
  });

  it('skipCI keeps its meaning: it merges without reading or watching CI', async () => {
    const { merges, watched, land } = setup({ checks: [running('ci')], noWait: true, skipCI: true });
    expect(await within(land())).toEqual({ settled: true });
    expect(merges).toEqual([undefined]);
    expect(watched).toEqual([]);
  });
});

const noWaitRows: Array<{ label: string; flags: Flags }> = [
  { label: 'noWait true over waitForCi true', flags: { noWait: true, waitForCi: true } },
  { label: 'waitForCi false with the option unset', flags: { waitForCi: false } },
];

const waitRows: Array<{ label: string; flags: Flags }> = [
  { label: 'noWait false over waitForCi false', flags: { noWait: false, waitForCi: false } },
  { label: 'waitForCi true with the option unset', flags: { waitForCi: true } },
  { label: 'both unset', flags: {} },
];

describe('landOpenPullRequest: the noWait option wins over land.waitForCi (#4307)', () => {
  it.each(noWaitRows)('$label does not wait: pending checks are checks_pending', async ({ flags }) => {
    const { merges, watched, land } = setup({ checks: [running('ci')], watchMode: 'success', ...flags });
    expect(isCiNotGreen(settledError(await within(land())))).toBe(true);
    expect(merges).toEqual([]);
    expect(watched).toEqual([]);
  });

  it.each(waitRows)('$label still waits on CI and merges the head it verified', async ({ flags }) => {
    const { merges, watched, land } = setup({ checks: [running('ci')], watchMode: 'success', ...flags });
    expect(await within(land())).toEqual({ settled: true });
    expect(watched).toEqual([HEAD]);
    expect(merges).toEqual([HEAD]);
  });
});
