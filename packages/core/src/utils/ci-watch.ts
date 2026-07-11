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
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function watchChecks(opts: WatchChecksOptions): Promise<CiOutcome> {
  const {
    octokit, owner, repo, ref,
    deadlineMs = 600_000,
    initialIntervalMs = 15_000,
    maxIntervalMs = 60_000,
    sleep = (ms) => new Promise<void>(r => setTimeout(r, ms)),
    now = () => Date.now(),
  } = opts;

  const deadline = now() + deadlineMs;
  let interval = initialIntervalMs;
  while (now() < deadline) {
    const { data: checks } = await octokit.rest.checks.listForRef({ owner, repo, ref });
    if (checks.check_runs.length > 0) {
      const allDone = checks.check_runs.every(r => r.status === 'completed');
      const anyFailed = checks.check_runs.some(r => r.conclusion === 'failure');
      if (allDone) return anyFailed ? 'failure' : 'success';
    }
    await sleep(interval);
    interval = Math.min(interval * 2, maxIntervalMs);
  }
  return 'timeout';
}
