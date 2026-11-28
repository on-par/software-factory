import { describe, expect, it, vi } from 'vitest';

import { rerunFailedJobsOnce } from './ci-failed-job-rerun.js';

const HEAD = 'd'.repeat(40);

type Run = { id?: number; name: string; status: string; conclusion: string; head_sha?: string | null };
type Job = { run_id?: number | null; run_attempt?: number | null; head_sha?: string | null };

const failedRun = (over: Partial<Run> = {}): Run => ({
  id: 3,
  name: 'smoke',
  status: 'completed',
  conclusion: 'failure',
  head_sha: HEAD,
  ...over,
});

function rig(runs: Run[], job: Job | Error, rerunOk = true) {
  const reruns: string[][] = [];
  const octokit = {
    rest: {
      checks: { listForRef: vi.fn(async () => ({ data: { check_runs: runs } })) },
      actions: {
        getJobForWorkflowRun: vi.fn(async () => {
          if (job instanceof Error) throw job;
          return { data: job };
        }),
      },
    },
  } as never;
  const rerun = vi.fn(async (argv: readonly string[]) => {
    reruns.push([...argv]);
    return { ok: rerunOk };
  });
  const rerunBudget = new Set<string>();
  const opts = { octokit, owner: 'o', repo: 'r', ref: 'b', checkNames: ['smoke'], rerun, rerunBudget };
  return { opts, reruns, rerunBudget };
}

const JOB: Job = { run_id: 40, run_attempt: 1, head_sha: HEAD };

describe('rerunFailedJobsOnce (#4337)', () => {
  it.each([
    {
      label: 'no check run failed',
      runs: [failedRun({ conclusion: 'success' })],
      job: JOB,
      reason: 'no failed check run on the PR head',
    },
    {
      label: 'another check also failed',
      runs: [failedRun(), failedRun({ id: 4, name: 'unit' })],
      job: JOB,
      reason: 'other checks also failed: unit',
    },
    {
      label: 'the run has no id',
      runs: [failedRun({ id: undefined })],
      job: JOB,
      reason: 'smoke has no check run id',
    },
    {
      label: 'the check is not an Actions job',
      runs: [failedRun()],
      job: new Error('404'),
      reason: 'smoke is not a GitHub Actions job',
    },
    {
      label: 'the job was already rerun',
      runs: [failedRun()],
      job: { ...JOB, run_attempt: 2 },
      reason: 'smoke was already rerun',
    },
    {
      label: 'the job has no workflow run id',
      runs: [failedRun()],
      job: { ...JOB, run_id: null },
      reason: 'smoke has no workflow run id',
    },
    {
      label: 'the head commit is unknown',
      runs: [failedRun({ head_sha: null })],
      job: { ...JOB, head_sha: null },
      reason: 'the PR head commit is unknown',
    },
  ])('skips without spending the budget when $label', async ({ runs, job, reason }) => {
    const { opts, reruns, rerunBudget } = rig(runs, job);
    expect(await rerunFailedJobsOnce(opts)).toEqual({ status: 'skipped', reason });
    expect(reruns).toEqual([]);
    expect([...rerunBudget]).toEqual([]);
  });

  it.each([
    { label: 'reruns once and spends the budget', ok: true, status: 'rerun' },
    { label: 'reports a failed rerun command and still spends the budget', ok: false, status: 'rerun-failed' },
  ])('$label', async ({ ok, status }) => {
    const { opts, reruns, rerunBudget } = rig([failedRun({ head_sha: null })], JOB, ok);
    expect(await rerunFailedJobsOnce(opts)).toEqual({ status, headSha: HEAD, runIds: [40] });
    expect(await rerunFailedJobsOnce(opts)).toEqual({
      status: 'skipped',
      reason: `the rerun budget for ${'d'.repeat(12)} is already spent`,
    });
    expect(reruns).toEqual([['gh', 'run', 'rerun', '40', '--failed', '--repo', 'o/r']]);
    expect([...rerunBudget]).toEqual([HEAD]);
  });
});
