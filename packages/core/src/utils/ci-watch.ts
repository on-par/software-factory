// src/utils/ci-watch.ts — shared CI watcher with exponential backoff
import type { Octokit } from '@octokit/rest';

export type CiOutcome = 'success' | 'failure' | 'timeout';

export interface WatchChecksOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  ref: string; // branch name or head SHA
  deadlineMs?: number; // default 600_000 (10 min)
  initialIntervalMs?: number; // default 15_000
  maxIntervalMs?: number; // default 60_000
  settleMs?: number; // default 30_000 — the check set must be unchanged across this gap
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** GitHub check-run conclusions that count as passing. Anything else on a
 *  completed run — timed_out, cancelled, action_required, startup_failure,
 *  stale, or a null conclusion — is a failure. New conclusions fail closed. */
const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(['success', 'neutral', 'skipped']);

interface CheckRunLike {
  id?: number;
  name?: string;
  status?: string | null;
  conclusion?: string | null;
}

function isFailedRun(run: CheckRunLike): boolean {
  return run.status === 'completed' && !PASSING_CONCLUSIONS.has(run.conclusion ?? '');
}

/** Identity of the observed check-run set. A slow workflow registering a new
 *  check run changes this, which is what defeats the partial-set race. */
function checkSetSignature(runs: CheckRunLike[]): string {
  return runs
    .map((r) => `${r.id ?? ''}#${r.name ?? ''}:${r.status ?? ''}:${r.conclusion ?? ''}`)
    .sort()
    .join('|');
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
    settleMs = 30_000,
    sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    now = () => Date.now(),
  } = opts;

  const deadline = now() + deadlineMs;
  let interval = initialIntervalMs;
  let settledSignature: string | undefined;

  while (now() < deadline) {
    const { data: checks } = await octokit.rest.checks.listForRef({ owner, repo, ref, per_page: 100 });
    const runs: CheckRunLike[] = checks.check_runs;

    // A confirmed failure is final — never wait for a settle.
    if (runs.some(isFailedRun)) return 'failure';

    const allDone = runs.length > 0 && runs.every((r) => r.status === 'completed');
    if (allDone) {
      const signature = checkSetSignature(runs);
      // Green only when the completed set is identical across the settle gap —
      // a check run that registered late changes the signature and re-arms.
      if (settledSignature === signature) return 'success';
      settledSignature = signature;
      await sleep(settleMs);
      continue; // settle waits do not consume the poll backoff
    }

    settledSignature = undefined;
    await sleep(interval);
    interval = Math.min(interval * 2, maxIntervalMs);
  }
  return 'timeout';
}
