// packages/cli/src/cli/awaiting-ci.ts — record store, backoff schedule and re-check runner for PRs whose CI never started (#3208)

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import type { EventKind } from '@on-par/factory-core';
import { warnNoBranchProtectionOnce, watchChecks } from '@on-par/factory-core/internal';

import { squashMergeAndDelete } from './land-pr.js';

export interface AwaitingCiRecord {
  issue: number;
  prNumber: number;
  branch: string;
  headSha: string;
  firstSeenAt: string;
  rechecks: number;
  nextRecheckAt: string;
}

export type AwaitingCiVerdict = 'green' | 'failed' | 'pending';

export type AwaitingCiRecheckResult =
  | { action: 'merged' | 'rescheduled' | 'cleared'; issue: number; prNumber: number }
  | {
      action: 'parked';
      issue: number;
      prNumber: number;
      branch: string;
      reason: 'ci-failed' | 'ci-never-started';
      msg: string;
    };

export interface AwaitingCiRecheckDeps {
  file: string;
  nowMs: () => number;
  capMs: number;
  getPr: (prNumber: number) => Promise<{ state: string; merged: boolean; headSha: string; baseRef?: string }>;
  verdict: (headSha: string, baseRef?: string) => Promise<AwaitingCiVerdict>;
  merge: (rec: AwaitingCiRecord, sha: string) => Promise<void>;
  /** False when auto-merge is off: a green PR is rescheduled, not merged. Default true. */
  mergeEnabled?: () => boolean;
  log: (type: EventKind, issue: number, msg: string) => void;
}

const MINUTE_MS = 60_000;
const RECHECK_OFFSETS_MS = [2 * MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS];
const LATE_RECHECK_INTERVAL_MS = 30 * MINUTE_MS;

export const awaitingCiFile = (paths: { state: string }): string => join(paths.state, 'awaiting-ci.json');

/** When re-check number `rechecks` (0-based) is due: first-seen + 2, 5, 15 min, then every 30 min (45, 75, ...). */
export function nextRecheckAt(firstSeenMs: number, rechecks: number): number {
  if (rechecks < RECHECK_OFFSETS_MS.length) return firstSeenMs + RECHECK_OFFSETS_MS[rechecks];
  return firstSeenMs + RECHECK_OFFSETS_MS[2] + LATE_RECHECK_INTERVAL_MS * (rechecks - 2);
}

/** Tolerant read: a missing or malformed file is an empty list, reported through `onMalformed`. */
export function readAwaitingCi(file: string, onMalformed?: (detail: string) => void): AwaitingCiRecord[] {
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed.filter(
      (r): r is AwaitingCiRecord =>
        typeof r === 'object' &&
        r !== null &&
        typeof r.issue === 'number' &&
        typeof r.prNumber === 'number' &&
        typeof r.headSha === 'string' &&
        typeof r.branch === 'string' &&
        Number.isFinite(Date.parse(r.firstSeenAt)) &&
        Number.isFinite(Date.parse(r.nextRecheckAt)) &&
        typeof r.rechecks === 'number',
    );
  } catch (err) {
    onMalformed?.(err instanceof Error ? err.message : String(err));
    return [];
  }
}

function writeAwaitingCi(file: string, records: AwaitingCiRecord[]): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Synchronous read-modify-write, so a record added while a re-check awaits is never lost. */
function updateAwaitingCi(file: string, fn: (records: AwaitingCiRecord[]) => AwaitingCiRecord[]): void {
  writeAwaitingCi(file, fn(readAwaitingCi(file)));
}

/** Upserts the record for `rec.issue`, first seen now, with its first re-check due in 2 minutes. */
export function recordAwaitingCi(
  file: string,
  rec: { issue: number; prNumber: number; headSha: string; branch: string },
  nowMs: number,
): AwaitingCiRecord {
  const record: AwaitingCiRecord = {
    ...rec,
    firstSeenAt: new Date(nowMs).toISOString(),
    rechecks: 0,
    nextRecheckAt: new Date(nextRecheckAt(nowMs, 0)).toISOString(),
  };
  updateAwaitingCi(file, (all) => [...all.filter((r) => r.issue !== rec.issue), record]);
  return record;
}

const clearRecord = (file: string, issue: number): void =>
  updateAwaitingCi(file, (all) => all.filter((r) => r.issue !== issue));

/** Walks the due records: merges a green PR pinned to its current head, parks a failed one (ci-failed) or one
 *  past the cap with no verdict (ci-never-started), and schedules the next re-check otherwise. Never throws. */
export async function runAwaitingCiRechecks(deps: AwaitingCiRecheckDeps): Promise<AwaitingCiRecheckResult[]> {
  const { file, nowMs, capMs, getPr, verdict, merge, mergeEnabled = () => true, log } = deps;
  const results: AwaitingCiRecheckResult[] = [];
  const due = readAwaitingCi(file, (d) =>
    log('warn', 0, `awaiting-ci state file ${file} is unreadable (${d}); treating it as empty`),
  ).filter((r) => Date.parse(r.nextRecheckAt) <= nowMs());
  for (const rec of due) {
    const { issue, prNumber } = rec;
    const reschedule = (headSha: string): void => {
      const firstSeen = Date.parse(rec.firstSeenAt);
      updateAwaitingCi(file, (all) =>
        all.map((r) =>
          r.issue === issue
            ? {
                ...r,
                headSha,
                rechecks: rec.rechecks + 1,
                nextRecheckAt: new Date(nextRecheckAt(firstSeen, rec.rechecks + 1)).toISOString(),
              }
            : r,
        ),
      );
      results.push({ action: 'rescheduled', issue, prNumber });
    };
    try {
      const pr = await getPr(prNumber);
      if (pr.state !== 'open' || pr.merged) {
        clearRecord(file, issue);
        log(
          'awaiting-ci',
          issue,
          `awaiting-ci: PR #${prNumber} is ${pr.merged ? 'merged' : 'closed'}; re-check dropped`,
        );
        results.push({ action: 'cleared', issue, prNumber });
        continue;
      }
      const sha = pr.headSha;
      const v = await verdict(sha, pr.baseRef);
      if (v === 'green') {
        if (!mergeEnabled()) {
          log(
            'awaiting-ci',
            issue,
            `awaiting-ci: PR #${prNumber} is green on ${sha.slice(0, 12)} but auto-merge is off`,
          );
          reschedule(sha);
          continue;
        }
        await merge(rec, sha);
        clearRecord(file, issue);
        log('landed', issue, `PR #${prNumber} merged on ${sha.slice(0, 12)} after CI arrived late`);
        results.push({ action: 'merged', issue, prNumber });
      } else if (v === 'failed') {
        clearRecord(file, issue);
        const msg = `CI failed for PR #${prNumber} on ${sha.slice(0, 12)} after starting late — refusing to merge with a failing check`;
        log('ci-failed', issue, msg);
        results.push({ action: 'parked', issue, prNumber, branch: rec.branch, reason: 'ci-failed', msg });
      } else if (nowMs() - Date.parse(rec.firstSeenAt) >= capMs) {
        clearRecord(file, issue);
        const hours = Math.round(((nowMs() - Date.parse(rec.firstSeenAt)) / 3_600_000) * 10) / 10;
        const msg = `PR #${prNumber} on ${sha.slice(0, 12)}: no CI run ever registered after ${hours} hours — CI or config problem, not a failing build`;
        log('ci-never-started', issue, msg);
        results.push({ action: 'parked', issue, prNumber, branch: rec.branch, reason: 'ci-never-started', msg });
      } else {
        reschedule(sha);
      }
    } catch (err) {
      log(
        'warn',
        issue,
        `awaiting-ci re-check of PR #${prNumber} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      try {
        reschedule(rec.headSha);
      } catch {}
    }
  }
  return results;
}

/** The default verdict: a short watchChecks pass on the head SHA (the required set, else every check run) mapped
 *  to green/failed/pending. Reuses the settle rule, so a late-registering check is never merged early. */
export function defaultAwaitingCiVerdict(
  octokit: Octokit,
  owner: string,
  repo: string,
  baseBranch: string,
  warn: (msg: string) => void = () => {},
): (headSha: string, baseRef?: string) => Promise<AwaitingCiVerdict> {
  return async (headSha, baseRef) => {
    const outcome = await watchChecks({
      octokit,
      owner,
      repo,
      ref: headSha,
      requiredChecks: { branch: baseRef ?? baseBranch },
      deadlineMs: 90_000,
      onNoRequiredChecks: ({ branch }) => warnNoBranchProtectionOnce(`${owner}/${repo}`, branch, warn),
    });
    if (outcome === 'success') return 'green';
    return outcome === 'failure' ? 'failed' : 'pending';
  };
}

/** Wires the lane deps for a GitHub-backed run: one record file, and one in-flight re-check shared by every lane. */
export function createAwaitingCiLaneDeps(opts: {
  file: string;
  octokit: Octokit;
  ghRepo: string;
  capMs: number;
  admin: boolean;
  mergeEnabled: boolean;
  log: (type: EventKind, issue: number, msg: string) => void;
  nowMs?: () => number;
}): {
  recordAwaitingCi: (rec: { issue: number; prNumber: number; headSha: string; branch: string }) => Promise<void>;
  recheckAwaitingCi: () => Promise<AwaitingCiRecheckResult[]>;
} {
  const { file, octokit, ghRepo, capMs, admin, mergeEnabled, log, nowMs = () => Date.now() } = opts;
  const [owner, repo] = ghRepo.split('/');
  const verdict = defaultAwaitingCiVerdict(octokit, owner, repo, 'main', (m) => log('warn', 0, m));
  let inFlight: Promise<AwaitingCiRecheckResult[]> | null = null;
  return {
    recordAwaitingCi: async (rec) => {
      recordAwaitingCi(file, rec, nowMs());
    },
    recheckAwaitingCi: () =>
      (inFlight ??= runAwaitingCiRechecks({
        file,
        nowMs,
        capMs,
        mergeEnabled: () => mergeEnabled,
        log,
        verdict,
        getPr: async (prNumber) => {
          const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
          return { state: data.state, merged: data.merged, headSha: data.head.sha, baseRef: data.base?.ref };
        },
        merge: (rec, sha) => squashMergeAndDelete(octokit, owner, repo, rec.branch, rec.prNumber, { admin, sha }),
      }).finally(() => {
        inFlight = null;
      })),
  };
}
