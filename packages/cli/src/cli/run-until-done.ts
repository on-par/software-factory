// packages/cli/src/cli/run-until-done.ts — `factory run --issue <n>`: carry one issue to merged, closed, parked or awaiting-review (#3908)

import { styleText } from 'node:util';

import type { RunOutcome } from '@on-par/factory-core';

import { CliExitError } from './errors.js';
import { parseMergeTimeout, type MergeResult } from './run-issue-merge.js';
import { validateRunReportFlags } from './run-report.js';

export type WaitMode = 'stay' | 'exit';
export type UntilDoneOutcome = 'merged' | 'closed' | 'parked' | 'awaiting-review';

/** Exit codes of `run --issue`; 10-14 belong to MERGE_EXIT, so 15 and 16 stay distinct from them. */
export const UNTIL_DONE_EXIT = { merged: 0, parked: 1, closed: 15, awaitingReview: 16 } as const;

export interface UntilDoneResult {
  outcome: UntilDoneOutcome;
  prNumber?: number;
  detail: string;
  /** Feedback rounds this invocation ran. */
  rounds: number;
}

export interface IssuePr {
  number: number;
  branch: string;
  state: 'open' | 'merged' | 'closed';
}

export interface UntilDoneInput {
  issue: number;
  wait: WaitMode;
  /** undefined: `stay` waits until a terminal outcome. */
  maxWaitMs: number | undefined;
  autoMerge: boolean;
  admin: boolean;
  mergeTimeoutMs: number;
}

export interface UntilDoneDeps {
  /** The newest factory PR for the issue: an open one first, else the newest merged or closed one. */
  findIssuePr(issue: number): Promise<IssuePr | undefined>;
  prState(prNumber: number): Promise<IssuePr['state']>;
  /** Ships the issue and returns the RunOutcome the pipeline reported. */
  ship(issue: number): Promise<RunOutcome | undefined>;
  driveToMerge(outcome: RunOutcome): Promise<MergeResult>;
  /** Seeds the local review-rework store from the PR's run-state comment on a fresh clone. */
  restorePrState(issue: number, branch: string): Promise<void>;
  /** How many trusted, unhandled feedback items the PR has. */
  pendingFeedback(prNumber: number): Promise<number>;
  /** One feedback round; a round that parks (the review-rework cap) reports `parked`. */
  feedbackRound(prNumber: number): Promise<{ parked: boolean; detail: string }>;
  /** Persists status `awaiting-review` on the PR before the command exits; never throws. */
  saveAwaitingReview(issue: number, prNumber: number): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
  pollMs: number;
  log(line: string): void;
}

function shippedPr(
  outcome: RunOutcome | undefined,
): { pr: IssuePr; outcome: RunOutcome } | { parked: string; prNumber?: number } {
  if (!outcome) return { parked: 'the run produced no outcome' };
  if (outcome.state === 'parked') {
    return { parked: `parked: ${outcome.reason}`, ...(outcome.prNumber ? { prNumber: outcome.prNumber } : {}) };
  }
  if (outcome.state === 'escalated' || outcome.state === 'released') {
    return { parked: `${outcome.state}: ${outcome.reason}` };
  }
  if (outcome.prNumber === undefined) return { parked: 'the run stopped before SHIP: no PR was opened' };
  return { pr: { number: outcome.prNumber, branch: outcome.branch, state: 'open' }, outcome };
}

/** Carries `input.issue` to a terminal outcome, or to awaiting-review when it waits for a human or runs out of time. */
export async function runUntilDone(input: UntilDoneInput, deps: UntilDoneDeps): Promise<UntilDoneResult> {
  const { issue } = input;
  let rounds = 0;
  const result = (outcome: UntilDoneOutcome, detail: string, prNumber?: number): UntilDoneResult => ({
    outcome,
    ...(prNumber === undefined ? {} : { prNumber }),
    detail,
    rounds,
  });

  let pr = await deps.findIssuePr(issue);
  if (pr?.state === 'merged') return result('merged', `PR #${pr.number} is already merged`, pr.number);
  if (pr?.state === 'closed') return result('closed', `PR #${pr.number} was closed without merging`, pr.number);

  let outcome: RunOutcome;
  if (pr) {
    outcome = { state: 'ready', route: 'claude', branch: pr.branch, reworkRounds: 0, prNumber: pr.number };
    await deps.restorePrState(issue, pr.branch);
  } else {
    const found = shippedPr(await deps.ship(issue));
    if ('parked' in found) return result('parked', found.parked, found.prNumber);
    ({ pr, outcome } = found);
  }
  const prNumber = pr.number;

  /** Drives the PR through the merge gates; undefined when a gate holds it for review. */
  const tryMerge = async (): Promise<UntilDoneResult | undefined> => {
    const m = await deps.driveToMerge(outcome);
    if (m.kind === 'merged') return result('merged', `merged PR #${prNumber}`, prNumber);
    if (m.kind === 'held') {
      deps.log(`PR #${prNumber} is held${m.gate ? ` by ${m.gate}` : ''}: ${m.detail}; waiting for review`);
      return undefined;
    }
    return result('parked', `${m.kind}: ${m.detail}`, prNumber);
  };

  if (input.autoMerge) {
    const merged = await tryMerge();
    if (merged) return merged;
  }

  const deadline = input.maxWaitMs === undefined ? Infinity : deps.now() + input.maxWaitMs;
  for (;;) {
    const state = await deps.prState(prNumber);
    if (state === 'merged') return result('merged', `PR #${prNumber} was merged`, prNumber);
    if (state === 'closed') return result('closed', `PR #${prNumber} was closed without merging`, prNumber);

    if ((await deps.pendingFeedback(prNumber)) > 0) {
      const round = await deps.feedbackRound(prNumber);
      rounds++;
      if (round.parked) return result('parked', round.detail, prNumber);
      if (input.autoMerge) {
        const merged = await tryMerge();
        if (merged) return merged;
      }
      continue;
    }

    if (input.wait === 'exit' || deps.now() >= deadline) {
      await deps.saveAwaitingReview(issue, prNumber);
      const why = input.wait === 'exit' ? 'no unhandled feedback' : '--max-wait elapsed';
      return result('awaiting-review', `PR #${prNumber} is open and waiting for review (${why})`, prNumber);
    }
    await deps.sleep(Math.min(deps.pollMs, deadline - deps.now()));
  }
}

/** `--wait`: undefined is `stay`; anything but stay or exit is a usage error. */
export function parseWaitMode(raw: string | undefined): WaitMode {
  if (raw === undefined) return 'stay';
  if (raw === 'stay' || raw === 'exit') return raw;
  throw new CliExitError('factory: --wait must be stay or exit', 2);
}

export interface UntilDoneFlagOptions {
  issue?: string | undefined;
  wait?: string | undefined;
  maxWait?: string | undefined;
  admin?: boolean | undefined;
  json?: boolean | undefined;
  export?: string | undefined;
  localQueue?: boolean | undefined;
  maxLanes?: string | undefined;
}

function parseMaxWait(raw: string | undefined): number | undefined {
  try {
    return parseMergeTimeout(raw);
  } catch (err) {
    if (err instanceof CliExitError) {
      throw new CliExitError('factory: --max-wait must be a positive duration like 30m or 2h', err.code);
    }
    throw err;
  }
}

/** Refuses the flag combinations `run` and `run --issue` cannot honour (exit 2); returns the parsed wait settings. */
export function validateUntilDoneFlags(opts: UntilDoneFlagOptions): { wait: WaitMode; maxWaitMs: number | undefined } {
  if (opts.issue === undefined) {
    const lifecycleOnly = [opts.wait, opts.maxWait, opts.admin || undefined, opts.json || undefined, opts.export];
    if (lifecycleOnly.some((v) => v !== undefined)) {
      throw new CliExitError('factory: --wait, --max-wait, --admin, --json and --export need --issue', 2);
    }
    return { wait: 'stay', maxWaitMs: undefined };
  }
  if (opts.localQueue || opts.maxLanes !== undefined) {
    throw new CliExitError('factory: --issue runs one issue — drop --local-queue and --max-lanes', 2);
  }
  validateRunReportFlags({ json: opts.json, ...(opts.export === undefined ? {} : { export: opts.export }) });
  return { wait: parseWaitMode(opts.wait), maxWaitMs: parseMaxWait(opts.maxWait) };
}

/** Prints the merge or throws a CliExitError carrying the outcome's exit code. */
export function exitForUntilDone(result: UntilDoneResult, issue: number): void {
  if (result.outcome === 'merged') {
    console.log(styleText('green', `✅ merged PR #${result.prNumber ?? '?'} for issue #${issue}`));
    return;
  }
  const pr = result.prNumber === undefined ? '' : ` (PR #${result.prNumber})`;
  const code = {
    parked: UNTIL_DONE_EXIT.parked,
    closed: UNTIL_DONE_EXIT.closed,
    'awaiting-review': UNTIL_DONE_EXIT.awaitingReview,
  }[result.outcome];
  throw new CliExitError(`factory: issue #${issue} ${result.outcome}${pr}: ${result.detail}`, code);
}
