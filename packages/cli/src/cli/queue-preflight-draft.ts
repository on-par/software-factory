// queue-preflight-draft.ts — adopt the issue's own factory draft PR that has no draftReason (#4039)

import type { Octokit } from '@octokit/rest';
import { workKeyFromIssue } from '@on-par/factory-core';
import {
  createFileIterateStore,
  factoryBranchIssue,
  isOwnComment,
  loadPrRunState,
  resolveSelfIdentity,
  type CiOutcome,
  type QueuePreflightDecision,
  type SelfIdentity,
} from '@on-par/factory-core/internal';

import { errorDetail } from './index.js';
import type { OpenPullRequestEvidence } from './queue-preflight.js';

type PrRunStateLoad = Awaited<ReturnType<typeof loadPrRunState>>;

export type FactoryDraftOwnership = 'factory' | 'requested' | 'not-factory';

export interface FactoryDraftFacts {
  issue: number;
  prNumber: number;
  branch: string;
  branchPrefix: string;
  /** run.pr.draft is on: a draft with no reason may be an intentional one whose SHIP never finished. */
  draftMode: boolean;
  runState: PrRunStateLoad;
  prAuthor: { id?: number; login?: string; type?: string } | null;
  /** GitHub account linked to the head commit's author; null when the email is unlinked. */
  headAuthor: { id?: number; login?: string; type?: string } | null;
  self: SelfIdentity;
}

export interface DraftAdoptionOps {
  classify(issue: number, pr: OpenPullRequestEvidence): Promise<FactoryDraftOwnership>;
  probeCi(headSha: string): Promise<CiOutcome>;
  queueCiRework(issue: number, prNumber: number): Promise<void>;
}

export function classifyFactoryDraft(facts: FactoryDraftFacts): FactoryDraftOwnership {
  if (factoryBranchIssue(facts.branch, facts.branchPrefix) !== facts.issue) return 'not-factory';
  if (facts.runState.status === 'found') {
    if (facts.runState.state.prNumber !== facts.prNumber) return 'not-factory';
    if (facts.runState.state.draftReason === 'requested') return 'requested';
  }
  if (facts.draftMode) return 'requested';
  if (!isOwnComment(facts.prAuthor, facts.self)) return 'not-factory';
  if (facts.headAuthor !== null && !isOwnComment(facts.headAuthor, facts.self)) return 'not-factory';
  return 'factory';
}

export async function factoryDraftDecision(
  issue: number,
  pr: OpenPullRequestEvidence,
  ops: DraftAdoptionOps | undefined,
  onDeferred?: (issue: number, message: string) => void,
): Promise<QueuePreflightDecision | undefined> {
  if (!ops) return undefined;
  let ownership: FactoryDraftOwnership;
  try {
    ownership = await ops.classify(issue, pr);
  } catch {
    return undefined;
  }
  if (ownership !== 'factory') return undefined;
  let outcome: CiOutcome;
  try {
    outcome = await ops.probeCi(pr.headSha);
  } catch (err) {
    onDeferred?.(issue, `CI probe for factory draft PR #${pr.number} failed: ${errorDetail(err)}`);
    return { kind: 'defer' };
  }
  if (outcome !== 'failure') return { kind: 'adopt', branch: pr.branch };
  try {
    await ops.queueCiRework(issue, pr.number);
  } catch (err) {
    onDeferred?.(
      issue,
      `CI failed on factory draft PR #${pr.number} but queuing CI rework failed: ${errorDetail(err)}`,
    );
    return { kind: 'defer' };
  }
  return { kind: 'build' };
}

export function makeDraftAdoptionOps(
  octokit: Octokit,
  owner: string,
  repo: string,
  opts: {
    branchPrefix: string;
    draftMode: boolean;
    iterateFile: string;
    probeCi: (headSha: string) => Promise<CiOutcome>;
    now?: () => Date;
  },
): DraftAdoptionOps {
  let self: Promise<SelfIdentity> | undefined;
  return {
    classify: async (issue, pr) => {
      if (self === undefined) {
        const pending = resolveSelfIdentity(octokit);
        self = pending;
        // A failed lookup is not memoized: the next call retries.
        pending.catch(() => {
          if (self === pending) self = undefined;
        });
      }
      const me = await self;
      const runState = await loadPrRunState({
        octokit,
        repo: `${owner}/${repo}`,
        prNumber: pr.number,
        key: workKeyFromIssue(issue),
      });
      const { data: pull } = await octokit.rest.pulls.get({ owner, repo, pull_number: pr.number });
      const { data: commit } = await octokit.rest.repos.getCommit({ owner, repo, ref: pr.headSha });
      return classifyFactoryDraft({
        issue,
        prNumber: pr.number,
        branch: pr.branch,
        branchPrefix: opts.branchPrefix,
        draftMode: opts.draftMode,
        runState,
        prAuthor: pull.user ?? null,
        headAuthor: commit.author ?? null,
        self: me,
      });
    },
    probeCi: opts.probeCi,
    queueCiRework: async (issue, prNumber) => {
      const at = (opts.now ?? (() => new Date()))();
      // A negative id cannot collide with a GitHub comment id (same convention as queueCiPendingRework).
      createFileIterateStore(opts.iterateFile).record({
        commentId: -at.getTime(),
        pr: prNumber,
        issue,
        actor: 'factory-queue-preflight',
        seenAt: at.toISOString(),
        outcome: 'queued',
        detail: 'CI failed on an adopted factory draft (#4039)',
      });
    },
  };
}
