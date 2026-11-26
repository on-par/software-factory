import type { Octokit } from '@octokit/rest';

import { type CiRerunBudget, DEFAULT_RERUN_BUDGET, isPassingConclusion, listAllCheckRuns } from './ci-watch.js';
import { runCommand } from './command-runner.js';

interface FailedJobRerunOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  ref: string;
  checkNames: readonly string[];
  rerun?: (argv: readonly string[]) => Promise<{ ok: boolean }>;
  rerunBudget?: CiRerunBudget;
}

type FailedJobRerun =
  { status: 'skipped'; reason: string } | { status: 'rerun' | 'rerun-failed'; headSha: string; runIds: number[] };

const PER_PAGE = 100;
const MAX_PAGES = 10;

const skipped = (reason: string): FailedJobRerun => ({ status: 'skipped', reason });

export async function rerunFailedJobsOnce(opts: FailedJobRerunOptions): Promise<FailedJobRerun> {
  const { octokit, owner, repo, ref, rerun = runCommand, rerunBudget = DEFAULT_RERUN_BUDGET } = opts;
  const wanted = new Set(opts.checkNames);
  const runs = await listAllCheckRuns(octokit, owner, repo, ref, PER_PAGE, MAX_PAGES);
  const failed = runs.filter((r) => r.status === 'completed' && !isPassingConclusion(r.conclusion));
  if (failed.length === 0) return skipped('no failed check run on the PR head');
  const others = failed.filter((r) => !wanted.has(r.name ?? ''));
  if (others.length > 0) return skipped(`other checks also failed: ${others.map((r) => r.name).join(', ')}`);
  const runIds = new Set<number>();
  let headSha = failed[0].head_sha ?? undefined;
  for (const run of failed) {
    if (typeof run.id !== 'number') return skipped(`${run.name} has no check run id`);
    let job: { run_id?: number | null; run_attempt?: number | null; head_sha?: string | null };
    try {
      ({ data: job } = await octokit.rest.actions.getJobForWorkflowRun({ owner, repo, job_id: run.id }));
    } catch {
      return skipped(`${run.name} is not a GitHub Actions job`);
    }
    if ((job.run_attempt ?? 1) > 1) return skipped(`${run.name} was already rerun`);
    if (typeof job.run_id !== 'number') return skipped(`${run.name} has no workflow run id`);
    runIds.add(job.run_id);
    headSha ??= job.head_sha ?? undefined;
  }
  if (!headSha) return skipped('the PR head commit is unknown');
  if (rerunBudget.has(headSha)) return skipped(`the rerun budget for ${headSha.slice(0, 12)} is already spent`);
  rerunBudget.add(headSha);
  const ids = [...runIds];
  for (const id of ids) {
    const r = await rerun(['gh', 'run', 'rerun', String(id), '--failed', '--repo', `${owner}/${repo}`]);
    if (!r.ok) return { status: 'rerun-failed', headSha, runIds: ids };
  }
  return { status: 'rerun', headSha, runIds: ids };
}
