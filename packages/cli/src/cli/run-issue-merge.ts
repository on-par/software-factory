// packages/cli/src/cli/run-issue-merge.ts — `run-issue --merge`: drive one PR through the run merge gates to a merge (#3905)

import { styleText } from 'node:util';

import type { getFactoryPaths, RunOutcome } from '@on-par/factory-core';

import { CliExitError } from './errors.js';
import { errorDetail } from './index.js';
import { waitForMerge } from './land.js';
import {
  AwaitingCiError,
  AwaitingReviewError,
  CiFailedError,
  CiUnverifiedError,
  LandConflictError,
  MergeGatedError,
} from './land-pr.js';
import { BaseCiPendingError } from './merge-base-gate.js';

export const MERGE_EXIT = {
  merged: 0,
  failedBeforePr: 1,
  held: 10,
  ciFailed: 11,
  timedOut: 12,
  landFailed: 13,
} as const;

export type MergeResultKind = 'merged' | 'held' | 'ci-failed' | 'timed-out' | 'failed-before-pr' | 'land-failed';

export interface MergeResult {
  kind: MergeResultKind;
  prNumber?: number;
  gate?: string;
  detail: string;
}

export interface DriveToMergeInput {
  issue: number;
  outcome: RunOutcome | undefined;
  repoRoot: string;
  ghRepo: string;
  paths: ReturnType<typeof getFactoryPaths>;
  timeoutMs: number;
  admin?: boolean;
  issueless?: boolean;
}

export interface DriveToMergeDeps {
  waitMerge?: typeof waitForMerge;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

const UNITS = { s: 1000, m: 60_000, h: 3_600_000 } as const;

/** `30m`, `2h`, `90s` → ms; undefined stays undefined; anything else is a usage error. */
export function parseMergeTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const m = /^(\d+)(s|m|h)$/.exec(raw);
  const ms = m ? Number(m[1]) * UNITS[m[2] as keyof typeof UNITS] : 0;
  if (ms > 0) return ms;
  throw new CliExitError('factory: --merge-timeout must be a positive duration like 30m or 2h', 2);
}

const CI_PARKS: ReadonlySet<string> = new Set(['ci-failed', 'ci-infra']);

function preMergeResult(outcome: RunOutcome | undefined): MergeResult | undefined {
  if (!outcome) return { kind: 'failed-before-pr', detail: 'the run produced no outcome' };
  if (outcome.state === 'parked') {
    if (CI_PARKS.has(outcome.reason)) {
      return {
        kind: 'ci-failed',
        ...(outcome.prNumber ? { prNumber: outcome.prNumber } : {}),
        detail: `parked: ${outcome.reason}`,
      };
    }
    return {
      kind: 'failed-before-pr',
      ...(outcome.prNumber ? { prNumber: outcome.prNumber } : {}),
      detail: `parked: ${outcome.reason}`,
    };
  }
  if (outcome.state === 'released' || outcome.state === 'escalated') {
    return { kind: 'failed-before-pr', detail: `run ${outcome.state}: ${outcome.reason}` };
  }
  const prNumber = outcome.prNumber;
  const pr = prNumber === undefined ? {} : { prNumber };
  if (outcome.state === 'ready' && outcome.draft) {
    return { kind: 'held', gate: 'draft', ...pr, detail: 'the PR was left as a draft' };
  }
  if (outcome.state === 'ready' && outcome.slice && outcome.slice.index < outcome.slice.count) {
    return {
      kind: 'held',
      gate: 'stack-slice',
      ...pr,
      detail: `slice ${outcome.slice.index} of ${outcome.slice.count}; later slices still to land`,
    };
  }
  if (!outcome.branch) return { kind: 'failed-before-pr', detail: 'the run produced no branch' };
  return undefined;
}

function isTimeout(err: unknown, signal: AbortSignal): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return signal.aborted || name === 'TimeoutError' || name === 'AbortError';
}

export async function driveToMerge(input: DriveToMergeInput, deps: DriveToMergeDeps = {}): Promise<MergeResult> {
  const early = preMergeResult(input.outcome);
  if (early) return early;
  const outcome = input.outcome as Extract<RunOutcome, { state: 'ready' | 'shipped' }>;
  const branch = outcome.branch;
  const prNumber = outcome.prNumber;
  const pr = prNumber === undefined ? {} : { prNumber };
  const { waitMerge = waitForMerge, now = () => Date.now(), sleep, pollMs = 60_000 } = deps;
  const doSleep = sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + input.timeoutMs;

  for (;;) {
    const signal = AbortSignal.timeout(Math.max(1, deadline - now()));
    try {
      await waitMerge(input.issue, branch, input.repoRoot, input.ghRepo, input.paths, {
        landBranch: branch,
        holdWhenGated: true,
        mergeOverrides: { auto: true, ...(input.admin ? { admin: true } : {}) },
        ...(input.issueless ? { issueless: true } : {}),
        signal,
      });
      return { kind: 'merged', ...pr, detail: 'merged' };
    } catch (err) {
      const detail = errorDetail(err);
      if (err instanceof MergeGatedError) {
        return { kind: 'held', gate: err.label, prNumber: err.prNumber || prNumber, detail };
      }
      if (err instanceof AwaitingReviewError) return { kind: 'held', gate: err.gate, prNumber: err.prNumber, detail };
      if (err instanceof LandConflictError) return { kind: 'land-failed', ...pr, detail };
      if (
        err instanceof CiUnverifiedError ||
        err instanceof AwaitingCiError ||
        err instanceof BaseCiPendingError
      ) {
        if (now() < deadline) {
          await doSleep(pollMs);
          continue;
        }
        return { kind: 'timed-out', ...pr, detail };
      }
      if (err instanceof CiFailedError) return { kind: 'ci-failed', ...pr, detail };
      if (isTimeout(err, signal)) return { kind: 'timed-out', ...pr, detail };
      return { kind: 'land-failed', ...pr, detail };
    }
  }
}

const EXIT_BY_KIND: Record<Exclude<MergeResultKind, 'merged'>, number> = {
  'failed-before-pr': MERGE_EXIT.failedBeforePr,
  held: MERGE_EXIT.held,
  'ci-failed': MERGE_EXIT.ciFailed,
  'timed-out': MERGE_EXIT.timedOut,
  'land-failed': MERGE_EXIT.landFailed,
};

/** Print the merge or throw a CliExitError carrying the distinct MERGE_EXIT code. */
export function exitForMerge(result: MergeResult, label: string): void {
  if (result.kind === 'merged') {
    console.log(styleText('green', `✅ merged PR #${result.prNumber ?? '?'} for ${label}`));
    return;
  }
  const gate = result.gate ? ` held by ${result.gate}` : '';
  const pr = result.prNumber ? ` (PR #${result.prNumber})` : '';
  throw new CliExitError(
    `factory: ${label} not merged (${result.kind})${gate}${pr}: ${result.detail}`,
    EXIT_BY_KIND[result.kind],
  );
}
