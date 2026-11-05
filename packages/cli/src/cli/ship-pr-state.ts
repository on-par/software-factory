// packages/cli/src/cli/ship-pr-state.ts — restore a run's resumable state from its PR on start and persist it there on every run-state update (#3909, ADR-0174)
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { Octokit } from '@octokit/rest';
import { workKeyFromIssue, type EventKind } from '@on-par/factory-core';
import {
  MAX_REWORK_ROUNDS,
  countReviewReworkRuns,
  createFileReviewReworkStore,
  loadPrRunState,
  lookupOpenPrByBranch,
  prRunStatusFor,
  readIssueRunState,
  resolveMaxReviewReworkRuns,
  reconcilePrRunState,
  runStateFile,
  savePrRunState,
  type PrRunRound,
  type IssueRunStateBase,
  type PrRunState,
  type RunStateUpdate,
} from '@on-par/factory-core/internal';
import { runStateRecorder } from './ship-run-state.js';

export interface RestoredPrRunState {
  prNumber: number;
  state: PrRunState;
}

type Log = (kind: EventKind, msg: string) => void;
type RunStateRecorder = (update: RunStateUpdate) => Promise<void>;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The run state this checkout holds for the issue (run record plus review-rework store), or null when it holds none. */
export async function localPrRunState(opts: {
  issueNum: number;
  prNumber: number;
  runsDir: string;
  reviewReworkFile: string;
  maxReviewReworkRuns: number;
}): Promise<PrRunState | null> {
  const key = workKeyFromIssue(opts.issueNum);
  const run = await readIssueRunState(runStateFile(opts.runsDir, key));
  const store = createFileReviewReworkStore(opts.reviewReworkFile);
  const records = store.list().filter((r) => String(r.issue) === key);
  if (run === null && records.length === 0) return null;
  const stamps = records.map((r) => r.startedAt ?? r.queuedAt).sort();
  return {
    version: 1,
    key,
    prNumber: run?.prNumber ?? opts.prNumber,
    status: run ? prRunStatusFor(run.status) : 'building',
    spec: { sha256: '', summary: '' },
    checkRework: { used: Math.max(0, (run?.attempts ?? 1) - 1), cap: MAX_REWORK_ROUNDS },
    reviewRework: { used: countReviewReworkRuns(store, key), cap: opts.maxReviewReworkRuns },
    handledReviewIds: records.filter((r) => r.startedAt).map((r) => r.reviewId),
    handledCommentIds: [],
    rounds: [],
    updatedAt: run?.updatedAt ?? stamps.at(-1) ?? new Date().toISOString(),
  };
}

/**
 * Loads the run state persisted on the issue's open PR, reconciles it with local state and seeds the review-rework
 * store with the handled review ids it lacks. Never throws: any failure logs `pr_state_failed` and restores nothing.
 */
export async function restorePrRunStateForRun(opts: {
  octokit: Octokit;
  repo: string;
  branch: string;
  issueNum: number;
  reviewReworkFile: string;
  runsDir: string;
  maxReviewReworkRuns: number;
  log: Log;
}): Promise<RestoredPrRunState | undefined> {
  const { octokit, repo, branch, issueNum, log } = opts;
  try {
    const found = await lookupOpenPrByBranch({ octokit, repo, branch });
    if (found.status === 'none') return undefined;
    if (found.status !== 'found') {
      const why = found.status === 'error' ? found.detail : `${found.prs.length} open PRs match ${branch}`;
      log('pr_state_failed', `could not look up the open PR for ${branch} to restore run state: ${why}`);
      return undefined;
    }
    const prNumber = found.prNumber;
    const key = workKeyFromIssue(issueNum);
    const loaded = await loadPrRunState({ octokit, repo, prNumber, key });
    for (const ig of loaded.ignored) {
      log('pr_state_ignored', `ignored PR #${prNumber} comment ${ig.commentId} as factory run state: ${ig.reason}`);
    }
    const local = await localPrRunState({ ...opts, prNumber });
    const state = reconcilePrRunState(local, loaded.status === 'found' ? loaded.state : null);
    if (state === null) return undefined;
    const store = createFileReviewReworkStore(opts.reviewReworkFile);
    for (const reviewId of state.handledReviewIds) {
      if (store.has(reviewId)) continue;
      const at = state.updatedAt;
      store.record({ reviewId, pr: prNumber, issue: issueNum, lane: '', reviewer: '', queuedAt: at, startedAt: at });
    }
    const { used, cap } = state.reviewRework;
    log(
      'pr_state_loaded',
      `restored run state from PR #${prNumber}: ${used} review-rework round(s) handled (${Math.max(0, cap - used)} remaining of cap ${cap}), ${state.checkRework.used} CHECK rework round(s), status ${state.status}`,
    );
    return { prNumber, state };
  } catch (err) {
    log('pr_state_failed', `could not restore run state from the PR: ${errorMessage(err)}`);
    return undefined;
  }
}

/** The frozen spec's sha256 and the text of its `## Goal` section; null when the file is unreadable. */
async function readSpecSummary(specPath: string): Promise<{ sha256: string; summary: string } | null> {
  try {
    const text = await readFile(specPath, 'utf8');
    const lines = text.split('\n');
    const start = lines.findIndex((l) => /^##\s+Goal\s*$/.test(l));
    const body = start < 0 ? [] : lines.slice(start + 1);
    const end = body.findIndex((l) => /^##\s/.test(l));
    const summary = (end < 0 ? body : body.slice(0, end)).join('\n').trim();
    return { sha256: createHash('sha256').update(text).digest('hex'), summary };
  } catch {
    return null;
  }
}

/**
 * Wraps the local run-state recorder: local state is written first, then, once a PR number is known, the merged
 * state is saved to the PR comment. A failure logs `pr_state_failed` and is swallowed.
 */
export function prRunStateRecorder(
  inner: (update: RunStateUpdate) => Promise<void>,
  opts: {
    octokit: Octokit;
    repo: string;
    issueNum: number;
    specPath: string;
    reviewReworkFile: string;
    runsDir: string;
    maxReviewReworkRuns: number;
    restored?: RestoredPrRunState;
    log: Log;
  },
): (update: RunStateUpdate) => Promise<void> {
  const { octokit, repo, issueNum, log } = opts;
  let known: PrRunState | null = opts.restored?.state ?? null;
  let prNumber = opts.restored?.prNumber;
  let attempts = 0;
  let lastSaved: string | undefined;
  const headSha = async (pr: number): Promise<string | undefined> => {
    const [owner, name] = repo.split('/');
    const { data } = await octokit.rest.pulls.get({ owner, repo: name, pull_number: pr });
    return /^[0-9a-f]{7,40}$/.test(data.head.sha) ? data.head.sha : undefined;
  };
  return async (update) => {
    await inner(update);
    try {
      prNumber = update.prNumber ?? prNumber;
      if (prNumber === undefined) return;
      const now = new Date().toISOString();
      const local = await localPrRunState({ ...opts, issueNum, prNumber });
      const reconciled = reconcilePrRunState(local, known);
      if (reconciled === null) return;
      // A new ship supersedes a stale reason: only this update's draftReason survives.
      const { draftReason: _stale, ...merged } = reconciled;
      const rounds: PrRunRound[] = [...merged.rounds];
      if (update.attempts !== undefined && update.attempts > attempts) {
        let sha: string | undefined;
        try {
          sha = await headSha(prNumber);
        } catch (err) {
          log('pr_state_failed', `could not read the PR head sha for the CHECK round: ${errorMessage(err)}`);
        }
        if (sha) attempts = update.attempts;
        if (sha) rounds.push({ kind: 'check', headSha: sha, at: now });
      }
      const state: PrRunState = {
        ...merged,
        prNumber,
        checkRework: { ...merged.checkRework, used: Math.max(merged.checkRework.used, attempts - 1) },
        status: prRunStatusFor(update.status, update.draftReason === 'ci-pending'),
        ...(update.draftReason ? { draftReason: update.draftReason } : {}),
        spec: (await readSpecSummary(opts.specPath)) ?? merged.spec,
        rounds,
        updatedAt: now,
      };
      known = state;
      const fingerprint = JSON.stringify({ ...state, updatedAt: '' });
      if (fingerprint === lastSaved) return;
      await savePrRunState({ octokit, repo, prNumber, state });
      lastSaved = fingerprint;
    } catch (err) {
      log('pr_state_failed', `could not save run state to the PR: ${errorMessage(err)}`);
    }
  };
}

/**
 * shipIssue's recordRunState factory: restores the PR state before the run starts, then returns a function that builds
 * the local recorder wrapped to save to the PR. `skip` (resume, local-only, --no-pr) keeps the bare local recorder.
 */
export async function shipRunStateRecorder(
  skip: unknown,
  opts: {
    octokit: Octokit;
    repo: string;
    branch: string;
    issueNum: number;
    factoryConfig: Parameters<typeof resolveMaxReviewReworkRuns>[0];
    paths: { reviewRework: string; runs: string };
    log: Log;
  },
): Promise<(base: Omit<IssueRunStateBase, 'issue' | 'branch'> & { specPath: string }) => RunStateRecorder> {
  const { paths, factoryConfig, branch, issueNum } = opts;
  const shared = {
    octokit: opts.octokit,
    repo: opts.repo,
    issueNum,
    log: opts.log,
    reviewReworkFile: paths.reviewRework,
    runsDir: paths.runs,
    maxReviewReworkRuns: resolveMaxReviewReworkRuns(factoryConfig),
  };
  const local = (base: IssueRunStateBase): RunStateRecorder => runStateRecorder(paths.runs, base);
  if (skip) return (base) => local({ ...base, issue: issueNum, branch });
  const restored = await restorePrRunStateForRun({ ...shared, branch });
  return (base) =>
    prRunStateRecorder(local({ ...base, issue: issueNum, branch }), { ...shared, specPath: base.specPath, restored });
}
