import type { Octokit } from '@octokit/rest';
import { runCommand } from './command-runner.js';
import { commitStatusCount, detectNoCiConfigured } from './ci-watch-no-ci.js';
import { type RequiredWaitingFor, readRequiredState, resolveRequiredContexts } from './ci-watch-required.js';
import { DEFAULT_CI_DEADLINE_MS } from './ci-deadline.js';

export { detectNoCiConfigured };

export type CiOutcome = 'success' | 'failure' | 'timeout' | 'no-checks';

export { DEFAULT_CI_DEADLINE_MS };
const DEFAULT_CI_INITIAL_INTERVAL_MS = 15_000;
const DEFAULT_CI_MAX_INTERVAL_MS = 60_000;

export interface CiWatchProgress {
  total: number;
  completed: number;
  pending: number;
  elapsedMs: number;
  remainingMs: number;
  waitingFor?: RequiredWaitingFor;
}

export interface CiNoChecksInfo {
  sha: string;
  waitedMs: number;
  reason: 'no-ci-configured' | 'grace-elapsed';
  defaultBranch?: string;
}

export interface WatchChecksOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  ref: string;
  deadlineMs?: number;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  perPage?: number;
  maxPages?: number;
  maxPollErrors?: number;
  minChecks?: number;
  settleMs?: number;
  noChecksGraceMs?: number;
  requiredChecks?: { branch: string };
  onNoRequiredChecks?: (info: { branch: string }) => void;
  probeNoCi?: boolean;
  progressIntervalMs?: number;
  onProgress?: (p: CiWatchProgress) => void;
  onNoChecks?: (info: CiNoChecksInfo) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

export function isPassingConclusion(conclusion: string | null | undefined): boolean {
  return PASSING_CONCLUSIONS.has(conclusion ?? '');
}

export type CiFailureClass = 'infra' | 'non-infra';

export interface CiJobStepLike {
  status?: string | null;
  started_at?: string | null;
}

export interface CiJobLike {
  conclusion?: string | null;
  run_id?: number | null;
  run_attempt?: number | null;
  head_sha?: string | null;
  runner_id?: number | null;
  runner_name?: string | null;
  steps?: CiJobStepLike[] | null;
}

function stepStarted(step: CiJobStepLike): boolean {
  return step.status === 'in_progress' || step.status === 'completed' || !!step.started_at;
}

export function classifyCiFailure(job: CiJobLike): CiFailureClass {
  if (isPassingConclusion(job.conclusion)) return 'non-infra';
  if ((job.runner_id === null || job.runner_id === 0) && !job.runner_name) return 'infra';
  if (Array.isArray(job.steps) && job.steps.length === 0) return 'infra';
  if (job.conclusion === 'cancelled' && Array.isArray(job.steps) && job.steps.every((s) => !stepStarted(s))) {
    return 'infra';
  }
  return 'non-infra';
}

const DEFAULT_PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_POLL_ERRORS = 3;
const DEFAULT_SETTLE_MS = 30_000;
const DEFAULT_MIN_CHECKS = 0;
const DEFAULT_PROGRESS_INTERVAL_MS = 60_000;

export type CheckRunLike = {
  id?: number;
  name?: string | null;
  head_sha?: string | null;
  status?: string | null;
  conclusion?: string | null;
  output?: { title?: string | null; summary?: string | null } | null;
  html_url?: string | null;
  details_url?: string | null;
};

export async function listAllCheckRuns(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  perPage: number,
  maxPages: number,
): Promise<CheckRunLike[]> {
  const runs: CheckRunLike[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await octokit.rest.checks.listForRef({ owner, repo, ref, per_page: perPage, page });
    const pageRuns = data.check_runs ?? [];
    runs.push(...pageRuns);
    if (pageRuns.length < perPage) break;
  }
  return runs;
}

export async function hasAnyCiSignal(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<boolean | undefined> {
  try {
    if ((await listAllCheckRuns(octokit, owner, repo, ref, 1, 1)).length > 0) return true;
  } catch {
    return undefined;
  }
  const statuses = await commitStatusCount(octokit, owner, repo, ref);
  if (!statuses) return undefined;
  return statuses.total > 0;
}

export async function watchChecks(opts: WatchChecksOptions): Promise<CiOutcome> {
  const {
    octokit,
    owner,
    repo,
    ref,
    deadlineMs = DEFAULT_CI_DEADLINE_MS,
    initialIntervalMs = DEFAULT_CI_INITIAL_INTERVAL_MS,
    maxIntervalMs = DEFAULT_CI_MAX_INTERVAL_MS,
    perPage = DEFAULT_PER_PAGE,
    maxPages = DEFAULT_MAX_PAGES,
    maxPollErrors = DEFAULT_MAX_POLL_ERRORS,
    minChecks = DEFAULT_MIN_CHECKS,
    settleMs = DEFAULT_SETTLE_MS,
    noChecksGraceMs = 0,
    requiredChecks,
    probeNoCi = false,
    progressIntervalMs = DEFAULT_PROGRESS_INTERVAL_MS,
    onProgress,
    onNoChecks,
    onNoRequiredChecks,
    sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    now = () => Date.now(),
  } = opts;

  const startedAt = now();
  const deadline = startedAt + deadlineMs;
  let lastProgressAt: number | undefined;
  let interval = initialIntervalMs;
  let consecutiveErrors = 0;
  let lastSeenRunCount = -1;
  let runCountUnchangedSince = now();
  let noCiProbed = false;
  let required: string[] | undefined;
  while (now() < deadline) {
    if (!required) {
      required = await resolveRequiredContexts(octokit, owner, repo, requiredChecks?.branch);
      if (required.length === 0 && requiredChecks?.branch) {
        try {
          onNoRequiredChecks?.({ branch: requiredChecks.branch });
        } catch {}
      }
    }
    try {
      const runs = await listAllCheckRuns(octokit, owner, repo, ref, perPage, maxPages);
      consecutiveErrors = 0;
      if (runs.length !== lastSeenRunCount) {
        lastSeenRunCount = runs.length;
        runCountUnchangedSince = now();
      }
      if (runs.length === 0 && (probeNoCi || noChecksGraceMs > 0) && !noCiProbed) {
        noCiProbed = true;
        const noCi = await detectNoCiConfigured(octokit, owner, repo, ref);
        if (noCi) {
          const statuses = await commitStatusCount(octokit, owner, repo, ref);
          if (statuses && statuses.total === 0) {
            try {
              onNoChecks?.({
                sha: statuses.sha,
                waitedMs: now() - startedAt,
                reason: 'no-ci-configured',
                defaultBranch: noCi.defaultBranch,
              });
            } catch {}
            return 'no-checks';
          }
        }
      }
      if (runs.length === 0 && noChecksGraceMs > 0 && now() - startedAt >= noChecksGraceMs) {
        const statuses = await commitStatusCount(octokit, owner, repo, ref);
        if (statuses && statuses.total === 0) {
          try {
            onNoChecks?.({ sha: statuses.sha, waitedMs: now() - startedAt, reason: 'grace-elapsed' });
          } catch {}
          return 'no-checks';
        }
      }
      const req = required.length > 0 ? await readRequiredState(octokit, owner, repo, ref, required, runs) : undefined;
      if (req?.statusFailed) return 'failure';
      const rs = req?.rs;
      if (runs.length > 0 && runs.every((r) => r.status === 'completed')) {
        const allPassed = runs.every((r) => isPassingConclusion(r.conclusion));
        if (!allPassed) return 'failure';
        if (rs) {
          if (rs.missing.length === 0 && rs.pending.length === 0) return 'success';
        } else {
          const setIsFinal = minChecks > 0 ? runs.length >= minChecks : now() - runCountUnchangedSince >= settleMs;
          if (setIsFinal) return 'success';
        }
      }
      if (
        (runs.length > 0 || rs?.state === 'pending') &&
        onProgress &&
        (lastProgressAt === undefined || now() - lastProgressAt >= progressIntervalMs)
      ) {
        const completed = runs.filter((r) => r.status === 'completed').length;
        lastProgressAt = now();
        try {
          onProgress({
            total: runs.length,
            completed,
            pending: runs.length - completed,
            elapsedMs: now() - startedAt,
            remainingMs: Math.max(0, deadline - now()),
            ...(req?.waitingFor.length ? { waitingFor: req.waitingFor } : {}),
          });
        } catch {}
      }
    } catch {
      consecutiveErrors++;
      if (consecutiveErrors >= maxPollErrors) return 'timeout';
    }
    await sleep(interval);
    interval = Math.min(interval * 2, maxIntervalMs);
  }
  return 'timeout';
}

export type CiRerunBudget = Set<string>;

export interface CiRescue {
  headSha: string;
  runIds: number[];
}

export type InfraRerunOutcome = CiOutcome | 'infra-failure';

export interface CiRescueFailure extends CiRescue {
  outcome: Exclude<InfraRerunOutcome, 'success'>;
}

export interface InfraRerunWatchOptions extends WatchChecksOptions {
  watch?: (opts: WatchChecksOptions) => Promise<CiOutcome>;
  rerun?: (argv: readonly string[]) => Promise<{ ok: boolean }>;
  rerunBudget?: CiRerunBudget;
  onRescued?: (rescue: CiRescue) => void;
  onRescueFailed?: (failure: CiRescueFailure) => void;
}

const DEFAULT_RERUN_BUDGET: CiRerunBudget = new Set();

async function infraFailedJobs(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  perPage: number,
  maxPages: number,
): Promise<{ headSha: string; jobs: CiJobLike[] } | null> {
  const runs = await listAllCheckRuns(octokit, owner, repo, ref, perPage, maxPages);
  const failed = runs.filter((r) => r.status === 'completed' && !isPassingConclusion(r.conclusion));
  if (failed.length === 0) return null;
  const jobs: CiJobLike[] = [];
  for (const run of failed) {
    if (typeof run.id !== 'number') return null;
    const { data: job } = await octokit.rest.actions.getJobForWorkflowRun({ owner, repo, job_id: run.id });
    if (classifyCiFailure(job) !== 'infra') return null;
    jobs.push(job);
  }
  const headSha = failed[0].head_sha ?? jobs[0].head_sha;
  if (!headSha) return null;
  return { headSha, jobs };
}

export async function watchChecksWithInfraRerun(opts: InfraRerunWatchOptions): Promise<InfraRerunOutcome> {
  const {
    watch = watchChecks,
    rerun = runCommand,
    rerunBudget = DEFAULT_RERUN_BUDGET,
    onRescued,
    onRescueFailed,
    ...watchOpts
  } = opts;
  const {
    octokit,
    owner,
    repo,
    ref,
    initialIntervalMs = DEFAULT_CI_INITIAL_INTERVAL_MS,
    perPage = DEFAULT_PER_PAGE,
    maxPages = DEFAULT_MAX_PAGES,
    sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  } = watchOpts;

  const first = await watch(watchOpts);
  if (first !== 'failure') return first;

  let rescue: CiRescue | undefined;
  let result: InfraRerunOutcome;
  try {
    const found = await infraFailedJobs(octokit, owner, repo, ref, perPage, maxPages);
    if (!found) return 'failure';
    const { headSha, jobs } = found;
    if (rerunBudget.has(headSha) || jobs.some((j) => (j.run_attempt ?? 1) > 1)) return 'failure';
    const runIds = [...new Set(jobs.map((j) => j.run_id).filter((id): id is number => typeof id === 'number'))];
    if (runIds.length === 0) return 'failure';
    rerunBudget.add(headSha);
    rescue = { headSha, runIds };
    result = 'failure';
    let rerunOk = true;
    for (const runId of runIds) {
      const r = await rerun(['gh', 'run', 'rerun', String(runId), '--failed', '--repo', `${owner}/${repo}`]);
      if (!r.ok) {
        rerunOk = false;
        break;
      }
    }
    if (rerunOk) {
      await sleep(initialIntervalMs);
      result = await watch(watchOpts);
      if (result === 'failure') {
        const again = await infraFailedJobs(octokit, owner, repo, ref, perPage, maxPages);
        if (again && again.headSha === headSha) result = 'infra-failure';
      }
    }
  } catch {
    result = 'failure';
  }
  if (rescue) {
    if (result === 'success') onRescued?.(rescue);
    else onRescueFailed?.({ ...rescue, outcome: result });
  }
  return result;
}
