// packages/cli/src/cli/run-until-done.ts — `factory run --issue <n>` / `run-issue <n> --until-done`: carry one issue to merged, closed or parked, answering review rounds (#3908)

import { styleText } from 'node:util';

import type { Octokit } from '@octokit/rest';
import {
  resolveMergePolicy,
  workKeyFromIssue,
  type FactoryConfig,
  type getFactoryPaths,
  type RunOutcome,
} from '@on-par/factory-core';
import {
  collectFeedbackItems,
  createOctokitCollaboratorPermissionClient,
  createOctokitFeedbackRoundGitHub,
  factoryBranchIssue,
  isTrustedApprover,
  loadPrRunState,
  MAX_REWORK_ROUNDS,
  resolveAwaitingCiCapMs,
  resolveMaxReviewReworkRuns,
  savePrRunState,
  type FeedbackItem,
  type PrRunState,
} from '@on-par/factory-core/internal';

import { CliExitError } from './errors.js';
import { respondDepsFrom, respondToPr, type RespondToPrResult } from './respond-command.js';
import { driveToMerge, type DriveToMergeInput, type MergeResult } from './run-issue-merge.js';
import { shipRuntime } from './ship-runtime.js';

export const WAIT_MODES = ['stay', 'exit'] as const;
export type WaitMode = (typeof WAIT_MODES)[number];

export type UntilDoneOutcome = 'merged' | 'closed' | 'parked' | 'awaiting-review';

/** Process exit codes; 10-13 belong to `--merge` (MERGE_EXIT). */
export const UNTIL_DONE_EXIT = { merged: 0, parked: 1, closed: 14, awaitingReview: 15 } as const;

export interface UntilDoneResult {
  outcome: UntilDoneOutcome;
  prNumber?: number;
  reason: string;
}

export interface FactoryPrRef {
  number: number;
  headRef: string;
  state: 'open' | 'closed';
  merged: boolean;
}

export function parseWaitMode(raw: string | undefined): WaitMode {
  if (raw === undefined) return 'stay';
  const mode = WAIT_MODES.find((m) => m === raw);
  if (mode === undefined) throw new CliExitError('factory: --wait must be stay or exit', 2);
  return mode;
}

const UNITS = { s: 1000, m: 60_000, h: 3_600_000 } as const;

function parseMaxWait(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const m = /^(\d+)(s|m|h)$/.exec(raw);
  const ms = m ? Number(m[1]) * UNITS[m[2] as keyof typeof UNITS] : 0;
  if (ms > 0) return ms;
  throw new CliExitError('factory: --max-wait must be a positive duration like 30m or 2h', 2);
}

export interface UntilDoneFlagOptions {
  untilDone?: boolean | undefined;
  wait?: string | undefined;
  maxWait?: string | undefined;
  merge?: boolean | undefined;
  /** `--no-pr` sets false. */
  pr?: boolean | undefined;
  stack?: boolean | undefined;
  workspace?: unknown;
}

/** The `--until-done` flag conflicts; each exits 2 before any run starts. Undefined when the mode is off. */
export function validateUntilDoneFlags(
  opts: UntilDoneFlagOptions,
): { wait: WaitMode; maxWaitMs: number | undefined } | undefined {
  if (!opts.untilDone) {
    if (opts.wait !== undefined || opts.maxWait !== undefined) {
      throw new CliExitError('factory: --wait/--max-wait need --until-done (or run --issue)', 2);
    }
    return undefined;
  }
  if (opts.merge) {
    throw new CliExitError('factory: --until-done already merges when auto-merge is on — drop --merge', 2);
  }
  if (opts.pr === false) throw new CliExitError('factory: --until-done needs a PR — drop --no-pr', 2);
  if (opts.stack) throw new CliExitError('factory: --until-done carries one PR — drop --stack', 2);
  if (opts.workspace !== undefined) {
    throw new CliExitError('factory: --until-done needs a PR — local-only (--workspace) runs never merge', 2);
  }
  return { wait: parseWaitMode(opts.wait), maxWaitMs: parseMaxWait(opts.maxWait) };
}

const PAGES = 3;

function toRef(pr: { number: number; state: string; merged_at?: string | null; head: { ref: string } }): FactoryPrRef {
  return {
    number: pr.number,
    headRef: pr.head.ref,
    state: pr.state === 'open' ? 'open' : 'closed',
    merged: pr.merged_at != null,
  };
}

/** The most recently updated same-repo factory PR for the issue, open or not (up to 300 PRs back). */
export async function findFactoryPrForIssue(
  octokit: Octokit,
  ghRepo: string,
  issue: number,
  branchPrefix: string,
): Promise<FactoryPrRef | undefined> {
  const [owner = '', repo = ''] = ghRepo.split('/');
  for (let page = 1; page <= PAGES; page++) {
    const { data } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
      page,
    });
    const hit = data.find(
      (pr) => pr.head.repo?.full_name === ghRepo && factoryBranchIssue(pr.head.ref, branchPrefix) === issue,
    );
    if (hit) return toRef(hit);
    if (data.length < 100) break;
  }
  return undefined;
}

export interface UntilDoneInput {
  issue: number;
  ghRepo: string;
  wait: WaitMode;
  maxWaitMs: number;
  autoMerge: boolean;
  admin: boolean;
  pollMs?: number;
  /** Caps for a minimal PR state written when the PR has none. */
  reviewReworkCap?: number;
  checkReworkCap?: number;
}

export interface UntilDoneDeps {
  findPr: () => Promise<FactoryPrRef | undefined>;
  getPr: (n: number) => Promise<FactoryPrRef>;
  /** Runs the pipeline once and returns its captured outcome; a throw with no outcome propagates. */
  ship: () => Promise<RunOutcome | undefined>;
  collectFeedback: (pr: number) => Promise<FeedbackItem[]>;
  respond: (pr: number, minUsed: number) => Promise<RespondToPrResult>;
  driveMerge: (pr: FactoryPrRef, timeoutMs: number) => Promise<MergeResult>;
  loadState: (pr: number) => Promise<PrRunState | undefined>;
  saveState: (pr: number, state: PrRunState) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (kind: string, msg: string) => void;
}

const DEFAULT_POLL_MS = 60_000;
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function minimalState(input: UntilDoneInput, pr: number, at: string): PrRunState {
  return {
    version: 1,
    key: workKeyFromIssue(input.issue),
    prNumber: pr,
    status: 'awaiting-review',
    spec: { sha256: '', summary: '' },
    checkRework: { used: 0, cap: input.checkReworkCap ?? MAX_REWORK_ROUNDS },
    reviewRework: { used: 0, cap: input.reviewReworkCap ?? 0 },
    handledReviewIds: [],
    handledCommentIds: [],
    rounds: [],
    updatedAt: at,
  };
}

async function shipFirstPr(deps: UntilDoneDeps): Promise<FactoryPrRef | UntilDoneResult> {
  let outcome: RunOutcome | undefined;
  try {
    outcome = await deps.ship();
  } catch (err) {
    return { outcome: 'parked', reason: errorMessage(err) };
  }
  if (outcome === undefined) return { outcome: 'parked', reason: 'the run produced no outcome' };
  if (outcome.state === 'parked' || outcome.state === 'released' || outcome.state === 'escalated') {
    return {
      outcome: 'parked',
      ...(outcome.state === 'parked' && outcome.prNumber ? { prNumber: outcome.prNumber } : {}),
      reason: outcome.reason,
    };
  }
  if (outcome.prNumber === undefined) return { outcome: 'parked', reason: 'no PR opened' };
  return deps.getPr(outcome.prNumber);
}

const isResult = (v: FactoryPrRef | UntilDoneResult): v is UntilDoneResult => 'outcome' in v;

/** Carry the issue's factory PR to merged, closed or parked; a human wait ends in `awaiting-review` (exit) or after `maxWaitMs` (stay). */
export async function runIssueUntilDone(input: UntilDoneInput, deps: UntilDoneDeps): Promise<UntilDoneResult> {
  const existing = await deps.findPr();
  let pr: FactoryPrRef;
  if (existing?.merged) return { outcome: 'merged', prNumber: existing.number, reason: 'already merged' };
  if (existing?.state === 'closed')
    return { outcome: 'closed', prNumber: existing.number, reason: 'closed without merging' };
  if (existing) {
    pr = existing;
  } else {
    const shipped = await shipFirstPr(deps);
    if (isResult(shipped)) return shipped;
    pr = shipped;
  }

  const deadline = deps.now() + input.maxWaitMs;
  let waitReason = 'waiting on a human';
  for (;;) {
    pr = await deps.getPr(pr.number);
    if (pr.merged) return { outcome: 'merged', prNumber: pr.number, reason: 'merged' };
    if (pr.state === 'closed') return { outcome: 'closed', prNumber: pr.number, reason: 'closed without merging' };

    const items = await deps.collectFeedback(pr.number);
    if (items.length > 0) {
      const state = await deps.loadState(pr.number);
      const round = await deps.respond(pr.number, state?.reviewRework.used ?? 0);
      if ('parked' in round) return { outcome: 'parked', prNumber: pr.number, reason: 'review-rework-cap' };
      deps.log('feedback_round', `PR #${pr.number}: ${items.length} item(s) answered`);
      continue;
    }

    if (input.autoMerge) {
      const m = await deps.driveMerge(pr, Math.max(1, deadline - deps.now()));
      if (m.kind === 'merged') return { outcome: 'merged', prNumber: pr.number, reason: 'merged' };
      if (m.kind === 'ci-failed' || m.kind === 'land-failed' || m.kind === 'failed-before-pr') {
        return { outcome: 'parked', prNumber: pr.number, reason: m.detail };
      }
      if (m.kind === 'held') waitReason = m.gate ? `held by ${m.gate}` : m.detail;
    }

    if (input.wait === 'exit') {
      const at = new Date(deps.now()).toISOString();
      const loaded = await deps.loadState(pr.number);
      const state = {
        ...(loaded ?? minimalState(input, pr.number, at)),
        status: 'awaiting-review' as const,
        updatedAt: at,
      };
      try {
        await deps.saveState(pr.number, state);
      } catch (err) {
        deps.log('pr_state_failed', `could not save run state to PR #${pr.number}: ${errorMessage(err)}`);
      }
      return { outcome: 'awaiting-review', prNumber: pr.number, reason: waitReason };
    }
    if (deps.now() >= deadline) return { outcome: 'awaiting-review', prNumber: pr.number, reason: 'max-wait' };
    await deps.sleep(input.pollMs ?? DEFAULT_POLL_MS);
  }
}

export interface UntilDoneWiring {
  octokit: Octokit;
  ghRepo: string;
  issue: number;
  branchPrefix: string;
  config: FactoryConfig;
  admin: boolean;
  /** Runs the pipeline with this onOutcome; the caller owns the run lock. */
  ship: (onOutcome: (o: RunOutcome) => void) => Promise<unknown>;
  drive: (input: Pick<DriveToMergeInput, 'issue' | 'outcome' | 'timeoutMs' | 'admin'>) => Promise<MergeResult>;
  respond: (prNumber: number, ctx: { minUsed: number; lock: false }) => Promise<RespondToPrResult>;
  log: (kind: string, msg: string) => void;
}

/** Production deps for runIssueUntilDone. */
export function untilDoneDepsFrom(w: UntilDoneWiring): UntilDoneDeps {
  const [owner = '', repo = ''] = w.ghRepo.split('/');
  const key = workKeyFromIssue(w.issue);
  const client = createOctokitCollaboratorPermissionClient(w.octokit);
  const trustedApprovers = w.config.intake?.trustedApprovers;
  return {
    findPr: () => findFactoryPrForIssue(w.octokit, w.ghRepo, w.issue, w.branchPrefix),
    getPr: async (n) => toRef((await w.octokit.rest.pulls.get({ owner, repo, pull_number: n })).data),
    ship: async () => {
      let outcome: RunOutcome | undefined;
      try {
        await w.ship((o) => (outcome = o));
      } catch (err) {
        if (outcome === undefined) throw err;
      }
      return outcome;
    },
    collectFeedback: (prNumber) =>
      collectFeedbackItems({
        github: createOctokitFeedbackRoundGitHub(w.octokit, owner, repo),
        prNumber,
        isTrusted: (login) => isTrustedApprover(login, { owner, repo, trustedApprovers, client }),
      }),
    respond: (prNumber, minUsed) => w.respond(prNumber, { minUsed, lock: false }),
    driveMerge: (pr, timeoutMs) =>
      w.drive({
        issue: w.issue,
        outcome: { state: 'ready', route: 'claude', branch: pr.headRef, prNumber: pr.number, reworkRounds: 0 },
        timeoutMs,
        ...(w.admin ? { admin: true } : {}),
      }),
    loadState: async (prNumber) => {
      const loaded = await loadPrRunState({ octokit: w.octokit, repo: w.ghRepo, prNumber, key });
      return loaded.status === 'found' ? loaded.state : undefined;
    },
    saveState: async (prNumber, state) => {
      await savePrRunState({ octokit: w.octokit, repo: w.ghRepo, prNumber, state });
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: w.log,
  };
}

/** Defaults for the minimal PR state's caps. */
export function untilDoneCaps(config: FactoryConfig): { reviewReworkCap: number; checkReworkCap: number } {
  return { reviewReworkCap: resolveMaxReviewReworkRuns(config), checkReworkCap: MAX_REWORK_ROUNDS };
}

/** Print the final outcome and exit with its code; merged returns normally. */
export function exitForUntilDone(
  result: UntilDoneResult,
  opts: { json?: boolean; issue: number; out?: (line: string) => void },
): void {
  const out = opts.out ?? console.log;
  const exitCode =
    result.outcome === 'awaiting-review' ? UNTIL_DONE_EXIT.awaitingReview : UNTIL_DONE_EXIT[result.outcome];
  const pr = result.prNumber === undefined ? '' : ` (PR #${result.prNumber})`;
  const line = `factory: issue #${opts.issue} ${result.outcome}${pr}: ${result.reason}`;
  if (opts.json) {
    out(
      JSON.stringify({
        schemaVersion: 1,
        issue: opts.issue,
        outcome: result.outcome,
        prNumber: result.prNumber ?? null,
        reason: result.reason,
        exitCode,
      }),
    );
    if (exitCode !== 0) throw new CliExitError('', exitCode);
    return;
  }
  if (exitCode === 0) {
    out(line);
    return;
  }
  throw new CliExitError(line, exitCode);
}

export interface DriveUntilDoneInput {
  wait: WaitMode;
  maxWaitMs: number | undefined;
  issue: number;
  ghRepo: string;
  repoRoot: string;
  paths: ReturnType<typeof getFactoryPaths>;
  branchPrefix: string;
  config: FactoryConfig;
  autoMerge: boolean | undefined;
  admin: boolean | undefined;
  json: boolean | undefined;
  octokit: Octokit;
  ship: UntilDoneWiring['ship'];
}

/** cmdRunIssue's `--until-done` path: resolve the merge policy, run the lifecycle, exit with its code. */
export async function driveUntilDone(a: DriveUntilDoneInput): Promise<void> {
  const policy = resolveMergePolicy(a.config, process.env, { auto: a.autoMerge, ...(a.admin ? { admin: true } : {}) });
  const result = await runIssueUntilDone(
    {
      issue: a.issue,
      ghRepo: a.ghRepo,
      wait: a.wait,
      maxWaitMs: a.maxWaitMs ?? resolveAwaitingCiCapMs(a.config),
      autoMerge: policy.auto,
      admin: policy.admin,
      ...untilDoneCaps(a.config),
    },
    untilDoneDepsFrom({
      octokit: a.octokit,
      ghRepo: a.ghRepo,
      issue: a.issue,
      branchPrefix: a.branchPrefix,
      config: a.config,
      admin: policy.admin,
      ship: a.ship,
      drive: (input) => driveToMerge({ ...input, repoRoot: a.repoRoot, ghRepo: a.ghRepo, paths: a.paths }),
      respond: (pr, ctx) => respondToPr(pr, respondDepsFrom(shipRuntime()), ctx),
      log: (kind, msg) => console.log(styleText('cyan', `${kind}: ${msg}`)),
    }),
  );
  exitForUntilDone(result, { issue: a.issue, ...(a.json ? { json: true } : {}) });
}
