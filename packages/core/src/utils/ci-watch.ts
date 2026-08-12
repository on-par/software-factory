// src/utils/ci-watch.ts — shared CI watcher with exponential backoff
import type { Octokit } from '@octokit/rest';

/** watchChecks reports exactly one of three outcomes: 'success' (every check run passed and the
 *  set was final — see `settleMs` / `minChecks`), 'failure' (a completed check run reported a
 *  non-passing conclusion), or 'timeout' (no verdict was reached — the deadline elapsed, no check
 *  runs ever registered, or repeated API failures exhausted the retry budget). It never rejects. */
export type CiOutcome = 'success' | 'failure' | 'timeout';

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
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Conclusions that count as a passing check. These are the three GitHub itself accepts for a
 *  required status check; `skipped` is the normal result of a path-filtered job. Anything not in
 *  this set blocks the merge — see ADR-0014
 *  (docs/adr/0014-ci-merge-gate-fails-closed-on-non-allow-listed-check-conclusions.md). */
const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const DEFAULT_PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_POLL_ERRORS = 3;
const DEFAULT_SETTLE_MS = 30_000;
const DEFAULT_MIN_CHECKS = 0;

type CheckRunLike = { status?: string | null; conclusion?: string | null };

async function listAllCheckRuns(
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

export async function watchChecks(opts: WatchChecksOptions): Promise<CiOutcome> {
  const {
    octokit,
    owner,
    repo,
    ref,
    deadlineMs = 600_000,
    initialIntervalMs = 15_000,
    maxIntervalMs = 60_000,
    perPage = DEFAULT_PER_PAGE,
    maxPages = DEFAULT_MAX_PAGES,
    maxPollErrors = DEFAULT_MAX_POLL_ERRORS,
    minChecks = DEFAULT_MIN_CHECKS,
    settleMs = DEFAULT_SETTLE_MS,
    sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    now = () => Date.now(),
  } = opts;

  const deadline = now() + deadlineMs;
  let interval = initialIntervalMs;
  let consecutiveErrors = 0;
  // GitHub's check-run set for a ref grows as workflows register, so a snapshot in which every
  // run is completed may simply be an early snapshot. Track when the current count was first
  // seen; a complete set is final only after that count holds still (or minChecks is met).
  let stableCount = -1;
  let stableSince = now();
  while (now() < deadline) {
    try {
      const runs = await listAllCheckRuns(octokit, owner, repo, ref, perPage, maxPages);
      consecutiveErrors = 0;
      if (runs.length !== stableCount) {
        stableCount = runs.length;
        stableSince = now();
      }
      if (runs.length > 0 && runs.every((r) => r.status === 'completed')) {
        // Fail closed: only an explicitly passing conclusion counts as green. `cancelled`,
        // `timed_out`, `action_required`, `stale`, a null conclusion on a completed run, and any
        // conclusion GitHub adds later all block the merge (ADR-0014).
        const allPassed = runs.every((r) => PASSING_CONCLUSIONS.has(r.conclusion ?? ''));
        // A red verdict needs no settle: a check run that registers later cannot turn a
        // completed check green.
        if (!allPassed) return 'failure';
        const setIsFinal = minChecks > 0 ? runs.length >= minChecks : now() - stableSince >= settleMs;
        if (setIsFinal) return 'success';
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
