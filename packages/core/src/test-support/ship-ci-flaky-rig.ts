import { vi } from 'vitest';

import type { EventKind } from '../events/kinds.js';
import type { CiRerunBudget, InfraRerunOutcome, watchChecksWithInfraRerun } from '../utils/ci-watch.js';
import { watchShipCi } from '../phases/ship-ci-watch.js';

export const FLAKY_HEAD = 'c'.repeat(40);
export const FLAKY_BASE = 'b'.repeat(40);
export const FLAKY_CHECK = 'deploy-preview-smoke';
export const FLAKY_RERUN_ARGV = ['gh', 'run', 'rerun', '507', '--failed', '--repo', 'o/r'];

export interface FlakyCiRigOptions {
  base: 'none' | 'passing' | 'failing';
  outcomes: InfraRerunOutcome[];
  budget?: CiRerunBudget;
  infraSpendsBudget?: boolean;
  rerunOk?: boolean;
}

export function flakyCiRig(opts: FlakyCiRigOptions) {
  const reruns: string[][] = [];
  const watches: InfraRerunOutcome[] = [];
  const headRuns = [
    { id: 7, name: FLAKY_CHECK, status: 'completed', conclusion: 'failure', head_sha: FLAKY_HEAD },
    { id: 8, name: 'test', status: 'completed', conclusion: 'success', head_sha: FLAKY_HEAD },
  ];
  const baseRuns = [
    { name: 'test', status: 'completed', conclusion: 'success' },
    ...(opts.base === 'none'
      ? []
      : [{ name: FLAKY_CHECK, status: 'completed', conclusion: opts.base === 'passing' ? 'success' : 'failure' }]),
  ];
  const octokit = {
    rest: {
      checks: {
        listForRef: vi.fn(async (a: { ref: string }) => ({
          data: { check_runs: a.ref === FLAKY_BASE ? baseRuns : headRuns },
        })),
      },
      repos: {
        getBranch: vi.fn(async (a: { branch: string }) => {
          if (a.branch !== 'main') throw new Error(`unexpected base branch ${a.branch}`);
          return { data: { commit: { sha: FLAKY_BASE } } };
        }),
      },
      actions: {
        getJobForWorkflowRun: vi.fn(async (a: { job_id: number }) => ({
          data: { run_id: 500 + a.job_id, run_attempt: 1, head_sha: FLAKY_HEAD },
        })),
      },
      codeScanning: { listAlertsForRepo: vi.fn(async () => ({ data: [] })) },
    },
  } as never;
  const outcomes = [...opts.outcomes];
  const ciWatch = vi.fn<typeof watchChecksWithInfraRerun>(async (o) => {
    if (opts.infraSpendsBudget) o.rerunBudget?.add(FLAKY_HEAD);
    const next = outcomes.shift() ?? 'failure';
    watches.push(next);
    return next;
  });
  const rerun = vi.fn(async (argv: readonly string[]) => {
    reruns.push([...argv]);
    return { ok: opts.rerunOk ?? true };
  });
  const rerunBudget = opts.budget ?? new Set<string>();
  const watch = (log: (type: EventKind, msg: string) => void) =>
    watchShipCi({
      octokit,
      owner: 'o',
      repo: 'o/r',
      repoName: 'r',
      prNumber: 9,
      watchRef: 'issue-1-fix-the-thing',
      headSha: FLAKY_HEAD,
      baseBranch: 'main',
      ciWatch,
      rerun,
      rerunBudget,
      sleep: async () => {},
      log,
    });
  return { watch, reruns, watches };
}
