// packages/cli/src/cli/run-issue-merge.ts — `run-issue --merge` / `run-brief --merge`: drive one PR to merge and map the result to an exit code (#3905)

import { styleText } from 'node:util';

import type { RunOutcome, getFactoryPaths } from '@on-par/factory-core';

import { CliExitError } from './errors.js';
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
import { landRuntime } from './land-runtime.js';

/** Process exit codes for a `--merge` run. 2 stays the usage-error code. */
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

const DURATION_UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 } as const;

/** `30m`, `2h`, `90s` → milliseconds; undefined stays undefined; anything else is a usage error. */
export function parseMergeTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const match = /^(\d+)(s|m|h)$/.exec(raw);
  const ms = match ? Number(match[1]) * DURATION_UNIT_MS[match[2] as keyof typeof DURATION_UNIT_MS] : 0;
  if (ms <= 0) throw new CliExitError('factory: --merge-timeout must be a positive duration like 30m or 2h', 2);
  return ms;
}

/** True only when the operator passed `--merge`; without it no run reaches waitForMerge. */
export function shouldDriveMerge(opts: { merge?: boolean }): boolean {
  return opts.merge === true;
}

function beforePr(outcome: RunOutcome | undefined): MergeResult | undefined {
  if (!outcome) return { kind: 'failed-before-pr', detail: 'the run ended without an outcome' };
  if (outcome.state === 'failed' || outcome.state === 'released') {
    return { kind: 'failed-before-pr', detail: `the run ${outcome.state} before a PR was ready` };
  }
  if (outcome.state === 'parked') {
    if (outcome.reason === 'ci-failed' || outcome.reason === 'ci-infra') {
      return {
        kind: 'ci-failed',
        ...(outcome.prNumber ? { prNumber: outcome.prNumber } : {}),
        detail: `CI failed after rework (${outcome.reason})`,
      };
    }
    return {
      kind: 'failed-before-pr',
      ...(outcome.prNumber ? { prNumber: outcome.prNumber } : {}),
      detail: `the run parked (${outcome.reason})`,
    };
  }
  if (outcome.state === 'ready') {
    const prNumber = outcome.prNumber ? { prNumber: outcome.prNumber } : {};
    if (outcome.draft) return { kind: 'held', ...prNumber, gate: 'draft', detail: 'the PR was left as a draft' };
    if (outcome.slice && outcome.slice.index < outcome.slice.count) {
      return {
        kind: 'held',
        ...prNumber,
        gate: 'stack-slice',
        detail: `slice ${outcome.slice.index} of ${outcome.slice.count}: later slices must ship first`,
      };
    }
  }
  return undefined;
}

function classify(err: unknown, signal: AbortSignal): MergeResult | 'retry' {
  const { errorDetail } = landRuntime();
  if (err instanceof MergeGatedError) {
    return {
      kind: 'held',
      ...(err.prNumber ? { prNumber: err.prNumber } : {}),
      gate: err.label,
      detail: errorDetail(err),
    };
  }
  if (err instanceof AwaitingReviewError) {
    return { kind: 'held', prNumber: err.prNumber, gate: err.gate, detail: errorDetail(err) };
  }
  if (err instanceof LandConflictError) return { kind: 'land-failed', detail: errorDetail(err) };
  if (err instanceof CiUnverifiedError || err instanceof AwaitingCiError || err instanceof BaseCiPendingError) {
    return 'retry';
  }
  if (err instanceof CiFailedError) {
    return { kind: 'ci-failed', ...(err.prNumber ? { prNumber: err.prNumber } : {}), detail: errorDetail(err) };
  }
  const name = (err as { name?: unknown } | null)?.name;
  if (signal.aborted || name === 'TimeoutError' || name === 'AbortError') {
    return { kind: 'timed-out', detail: 'the merge wait was aborted at its deadline' };
  }
  return { kind: 'land-failed', detail: errorDetail(err) };
}

/** Wait for CI and land the PR through the `factory run --auto-merge` gates; never merges past a gate. */
export async function driveToMerge(input: DriveToMergeInput, deps: DriveToMergeDeps = {}): Promise<MergeResult> {
  const { waitMerge = waitForMerge, now = () => Date.now(), sleep, pollMs = 60_000 } = deps;
  const doSleep = sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const early = beforePr(input.outcome);
  if (early) return early;
  const branch = input.outcome && 'branch' in input.outcome ? input.outcome.branch : undefined;
  if (!branch) return { kind: 'failed-before-pr', detail: 'the run produced no branch to merge' };
  const prNumber = input.outcome && 'prNumber' in input.outcome ? input.outcome.prNumber : undefined;

  const deadline = now() + input.timeoutMs;
  for (;;) {
    const signal = AbortSignal.timeout(Math.max(1, deadline - now()));
    try {
      await waitMerge(input.issue, branch, input.repoRoot, input.ghRepo, input.paths, {
        landBranch: branch,
        holdWhenGated: true,
        mergeOverrides: { auto: true, ...(input.admin ? { admin: input.admin } : {}) },
        ...(input.issueless ? { issueless: input.issueless } : {}),
        signal,
      });
      return { kind: 'merged', ...(prNumber ? { prNumber } : {}), detail: 'merged' };
    } catch (err) {
      const result = classify(err, signal);
      if (result !== 'retry') return result.prNumber || !prNumber ? result : { ...result, prNumber };
      if (now() >= deadline) {
        return { kind: 'timed-out', detail: `CI was still pending at the deadline: ${landRuntime().errorDetail(err)}` };
      }
      await doSleep(pollMs);
    }
  }
}

/** Print the merged line, or throw a CliExitError carrying the MERGE_EXIT code. */
export function exitForMerge(result: MergeResult, label: string): void {
  if (result.kind === 'merged') {
    const pr = result.prNumber ? `PR #${result.prNumber}` : 'PR';
    console.log(styleText('green', `✅ merged ${pr} for ${label}`));
    return;
  }
  const code = {
    held: MERGE_EXIT.held,
    'ci-failed': MERGE_EXIT.ciFailed,
    'timed-out': MERGE_EXIT.timedOut,
    'land-failed': MERGE_EXIT.landFailed,
    'failed-before-pr': MERGE_EXIT.failedBeforePr,
  }[result.kind];
  const gate = result.gate ? ` held by ${result.gate}` : '';
  const pr = result.prNumber ? ` PR #${result.prNumber}:` : ':';
  throw new CliExitError(`factory: ${label} not merged (${result.kind})${gate}${pr} ${result.detail}`, code);
}
