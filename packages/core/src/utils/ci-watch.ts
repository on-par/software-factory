// src/utils/ci-watch.ts — shared CI watcher with exponential backoff
import type { Octokit } from '@octokit/rest';
import { runCommand } from './command-runner.js';
import { commitStatusCount, detectNoCiConfigured } from './ci-watch-no-ci.js';
import { type RequiredWaitingFor, readRequiredState, resolveRequiredContexts } from './ci-watch-required.js';
import { DEFAULT_CI_DEADLINE_MS } from './ci-deadline.js';

export { detectNoCiConfigured };

/** watchChecks reports exactly one of four outcomes: 'success' (every check run passed and the
 *  set was final — see `settleMs` / `minChecks`), 'failure' (a completed check run reported a
 *  non-passing conclusion), 'timeout' (no verdict was reached — the deadline elapsed, no check
 *  runs ever registered, or repeated API failures exhausted the retry budget), or 'no-checks'
 *  (returned only when the ref has zero check runs and zero commit statuses: at once from the
 *  up-front no-CI probe when `probeNoCi` or `noChecksGraceMs` > 0 and it proves the repo has no CI
 *  configured, #2488, or once the grace period has passed when `noChecksGraceMs` > 0). It never
 *  rejects. */
export type CiOutcome = 'success' | 'failure' | 'timeout' | 'no-checks';

export { DEFAULT_CI_DEADLINE_MS };
export const DEFAULT_CI_NO_CHECKS_GRACE_MS = 90_000;
const DEFAULT_CI_INITIAL_INTERVAL_MS = 15_000;
const DEFAULT_CI_MAX_INTERVAL_MS = 60_000;

/** Snapshot passed to `onProgress` while check runs are pending. */
export interface CiWatchProgress {
  total: number;
  completed: number;
  pending: number;
  elapsedMs: number;
  remainingMs: number;
  /** Required checks the watch is still waiting for (#3206); set only when some are pending. */
  waitingFor?: RequiredWaitingFor;
}

/** Passed to `onNoChecks` when the watch ends 'no-checks'. */
export interface CiNoChecksInfo {
  sha: string;
  waitedMs: number;
  /** 'no-ci-configured' when the up-front probe proved the repo has no CI (#2488);
   *  'grace-elapsed' when noChecksGraceMs passed with no checks (#2386). */
  reason: 'no-ci-configured' | 'grace-elapsed';
  /** Default branch the probe inspected; set only for 'no-ci-configured'. */
  defaultBranch?: string;
}

export interface WatchChecksOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  ref: string; // branch name or head SHA
  deadlineMs?: number; // default 600_000 (10 min)
  initialIntervalMs?: number; // default 15_000
  maxIntervalMs?: number; // default 60_000
  perPage?: number; // default 100
  maxPages?: number; // default 10
  maxPollErrors?: number; // default 3
  /** Minimum number of check runs the caller expects for this ref (it knows the repo's required
   *  checks). When > 0, a complete all-passing set of at least this many runs is final at once and
   *  the settle window is skipped; a smaller set is never final. Default 0 (undeclared). */
  minChecks?: number;
  /** How long the observed check-run count must stay unchanged before a complete all-passing set
   *  counts as final, when no minChecks is declared. Default 30_000. */
  settleMs?: number;
  /** Once this long has passed since the watch started, a successful poll that sees zero check
   *  runs and a combined commit status with zero statuses ends the watch 'no-checks' (#2386).
   *  A repo proven to have no CI (no workflow files, no checks or statuses on recent default-branch
   *  commits) ends 'no-checks' on the first such poll without waiting (#2488).
   *  Default 0, which disables the early exit and the probe. */
  noChecksGraceMs?: number;
  /** The branch whose required checks (protection plus rulesets) gate success (#3206). While any
   *  is missing or running the watch keeps polling. Unset, or a branch with none, keeps the
   *  all-check-runs rule. */
  requiredChecks?: { branch: string };
  /** Called once per watch when `requiredChecks.branch` resolves to zero required contexts, so the gate falls back to all
   *  checks on the head (#3208). A throw is swallowed. */
  onNoRequiredChecks?: (info: { branch: string }) => void;
  /** Run the #2488 no-CI probe without the grace-elapsed exit. Default false. */
  probeNoCi?: boolean;
  /** Minimum gap between onProgress calls. Default 60_000. */
  progressIntervalMs?: number;
  /** Called after a successful poll that sees at least one check run (or a pending required check)
   *  and does not end the watch, at most once per progressIntervalMs. */
  onProgress?: (p: CiWatchProgress) => void;
  /** Called once, just before the watch returns 'no-checks'. */
  onNoChecks?: (info: CiNoChecksInfo) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Conclusions that count as a passing check. These are the three GitHub itself accepts for a
 *  required status check; `skipped` is the normal result of a path-filtered job. Anything not in
 *  this set blocks the merge — see ADR-0014
 *  (docs/adr/0014-ci-merge-gate-fails-closed-on-non-allow-listed-check-conclusions.md). */
const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/** True when a completed check run's conclusion counts as passing. The three conclusions GitHub
 *  itself accepts for a required status check; `skipped` is the normal result of a path-filtered
 *  job. Anything else blocks the merge — see ADR-0014. Exported so the `factory doctor`
 *  green-PR report (utils/green-prs.ts) decides "green" with the same fail-closed allow-list the
 *  merge gate uses, instead of re-declaring it. */
export function isPassingConclusion(conclusion: string | null | undefined): boolean {
  return PASSING_CONCLUSIONS.has(conclusion ?? '');
}

/** Whether a failed CI job failed for infrastructure reasons ('infra') or any other reason
 *  ('non-infra'), including real test failures. */
export type CiFailureClass = 'infra' | 'non-infra';

/** Structural subset of a GitHub Actions workflow-job step (actions.listJobsForWorkflowRun). */
export interface CiJobStepLike {
  status?: string | null;
  started_at?: string | null;
}

/** Structural subset of a GitHub Actions workflow job — only the fields the classifier reads. */
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

/** Classify a CI job as an infrastructure failure or not. Pure; rules run in order:
 *  1. a passing conclusion is never infra;
 *  2. no runner assigned (`runner_id` null/0 and no `runner_name`) is infra;
 *  3. a present-but-empty `steps` array (zero steps ran) is infra;
 *  4. a `cancelled` job whose steps never started is infra;
 *  5. anything else is 'non-infra'.
 *  Fails closed: missing (undefined) fields are unknown, never an infra signal, so a real test
 *  failure is not mislabelled. */
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

/** Grace before a watch gives up on a ref with no check runs and no statuses: the
 *  FACTORY_CI_NO_CHECKS_GRACE_SECONDS env var (a finite number >= 0; 0 disables), else 90 s. */
export function resolveCiNoChecksGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FACTORY_CI_NO_CHECKS_GRACE_SECONDS?.trim();
  if (!raw) return DEFAULT_CI_NO_CHECKS_GRACE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : DEFAULT_CI_NO_CHECKS_GRACE_MS;
}

/** Elapsed sleep time of the first watchChecks poll at or after `graceMs`, i.e. when a ref with
 *  no checks gets its grace-elapsed 'no-checks' verdict (API latency not included). 105 s for
 *  the defaults. 0 when graceMs <= 0. */
export function noChecksVerdictMs(
  graceMs: number = DEFAULT_CI_NO_CHECKS_GRACE_MS,
  initialIntervalMs: number = DEFAULT_CI_INITIAL_INTERVAL_MS,
  maxIntervalMs: number = DEFAULT_CI_MAX_INTERVAL_MS,
): number {
  if (graceMs <= 0) return 0;
  if (initialIntervalMs <= 0) return graceMs;
  let t = 0;
  let interval = initialIntervalMs;
  while (t < graceMs) {
    t += interval;
    interval = Math.min(interval * 2, maxIntervalMs);
  }
  return t;
}

export type CheckRunLike = {
  id?: number;
  name?: string | null;
  head_sha?: string | null;
  status?: string | null;
  conclusion?: string | null;
  output?: { title?: string | null; summary?: string | null } | null;
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

/** Whether the ref has any check run or commit status at all (#3208). `false` only when both counts are zero;
 *  `undefined` when either lookup fails, so callers fail closed. */
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
  // GitHub's check-run set for a ref grows as workflows register, so a snapshot in which every
  // run is completed may simply be an early snapshot. Track when the current count was first
  // seen; a complete set is final only after that count holds still (or minChecks is met).
  let stableCount = -1;
  let stableSince = now();
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
      if (runs.length !== stableCount) {
        stableCount = runs.length;
        stableSince = now();
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
        // Unknown (null) keeps polling; it is not a poll error.
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
        // Fail closed: only an explicitly passing conclusion counts as green. `cancelled`,
        // `timed_out`, `action_required`, `stale`, a null conclusion on a completed run, and any
        // conclusion GitHub adds later all block the merge (ADR-0014).
        const allPassed = runs.every((r) => isPassingConclusion(r.conclusion));
        // A red verdict needs no settle: a check run that registers later cannot turn a
        // completed check green.
        if (!allPassed) return 'failure';
        if (rs) {
          // The required set is known, so there is nothing to settle: done once none is missing or running.
          if (rs.missing.length === 0 && rs.pending.length === 0) return 'success';
        } else {
          const setIsFinal = minChecks > 0 ? runs.length >= minChecks : now() - stableSince >= settleMs;
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
      // A failed poll observes nothing this iteration rather than aborting the watch; give up
      // (as "no verdict", never as success) only after maxPollErrors consecutive failures.
      consecutiveErrors++;
      if (consecutiveErrors >= maxPollErrors) return 'timeout';
    }
    await sleep(interval);
    interval = Math.min(interval * 2, maxIntervalMs);
  }
  return 'timeout';
}

/** One-shot rerun budget keyed by PR head SHA: a SHA in the set is never rerun again. */
export type CiRerunBudget = Set<string>;

export interface CiRescue {
  headSha: string;
  runIds: number[];
}

/** watchChecksWithInfraRerun's verdict: a CiOutcome, or 'infra-failure' when the one rerun
 *  also failed and every failed run is still infra on the same head SHA (#2366). */
export type InfraRerunOutcome = CiOutcome | 'infra-failure';

export interface CiRescueFailure extends CiRescue {
  outcome: Exclude<InfraRerunOutcome, 'success'>;
}

export interface InfraRerunWatchOptions extends WatchChecksOptions {
  /** The watcher to wrap; default watchChecks. */
  watch?: (opts: WatchChecksOptions) => Promise<CiOutcome>;
  /** Runs the gh rerun argv; default runCommand. */
  rerun?: (argv: readonly string[]) => Promise<{ ok: boolean }>;
  /** Default: a module-level Set shared by every call in this process. */
  rerunBudget?: CiRerunBudget;
  /** Called once when the post-rerun watch is green. */
  onRescued?: (rescue: CiRescue) => void;
  /** Called once when a rerun was issued in this call and the final verdict is not success. */
  onRescueFailed?: (failure: CiRescueFailure) => void;
}

const DEFAULT_RERUN_BUDGET: CiRerunBudget = new Set();

/** Lists the failed check runs for a ref and fetches each Actions job. Returns null on any
 *  non-infra job, missing numeric id, zero failed runs or missing head SHA. May throw. */
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

/** watchChecks plus a one-shot rescue for infrastructure failures (#2365). When the watch ends
 *  'failure' and every failed check run maps to an Actions job that classifyCiFailure calls
 *  'infra', the failed jobs are rerun once (`gh run rerun <run> --failed`) and CI is watched
 *  again. Budget: one rerun per head SHA (in-process Set) and never for a job already on
 *  run_attempt > 1, so there is no second rerun and no loop. Fails closed: any non-infra job,
 *  non-Actions check run, missing field or API error returns 'failure' unchanged. Never rejects.
 *  When the re-watch also fails, the failed runs are classified again: all still infra on the
 *  same head SHA returns 'infra-failure' (#2366), anything else 'failure'. onRescueFailed fires
 *  once whenever a rerun budget was spent in this call and the final verdict is not success. */
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
    initialIntervalMs = 15_000,
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
