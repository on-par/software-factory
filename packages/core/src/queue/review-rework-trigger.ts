// packages/core/src/queue/review-rework-trigger.ts — a trusted CHANGES_REQUESTED review on a factory PR queues its issue for review rework, once per review id (#3563, ADR-0128 trust).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Octokit } from '@octokit/rest';

import { factoryBranchIssue } from '../utils/index.js';
import { isTrustedApprover, type CollaboratorPermissionClient } from './approval.js';
import { IN_PROGRESS_LABEL, LANE_LABEL_PREFIX, PARKED_LABEL, type QueueGitHubClient } from './github-queue.js';
import { createEnqueuers } from './github-queue-enqueue.js';

export interface ReviewReworkPull {
  number: number;
  headRef: string;
  /** `owner/repo` of the head; undefined when unknown (deleted fork). */
  headRepo?: string;
}

export interface ReviewReworkReview {
  id: number;
  state: string;
  login: string;
  submittedAt?: string;
}

export interface ReviewReworkGitHub {
  listOpenPulls(): Promise<ReviewReworkPull[]>;
  /** Reviews in GitHub's chronological order. */
  listReviews(pr: number): Promise<ReviewReworkReview[]>;
}

export interface ReviewReworkRecord {
  reviewId: number;
  pr: number;
  issue: number;
  lane: string;
  reviewer: string;
  queuedAt: string;
  /** Set when a lane claimed the record for a review-rework run (#3564). */
  startedAt?: string;
}

export interface ReviewReworkStore {
  has(reviewId: number): boolean;
  record(entry: ReviewReworkRecord): void;
  list(): ReviewReworkRecord[];
  /** Stamp `startedAt` on a record; an unknown id does nothing. */
  markStarted(reviewId: number, at: string): void;
}

export type ReviewReworkOutcome = 'queued' | 'already-queued' | 'skipped' | 'error';

export interface ReviewReworkPollResult {
  pr: number;
  issue: number;
  outcome: ReviewReworkOutcome;
  reviewIds: number[];
  reviewer?: string;
  lane?: string;
  detail?: string;
}

export interface PollReviewReworkOptions {
  github: ReviewReworkGitHub;
  queue: QueueGitHubClient;
  owner: string;
  repo: string;
  branchPrefix?: string;
  trustedApprovers?: readonly string[];
  permissions: CollaboratorPermissionClient;
  store: ReviewReworkStore;
  now?: () => Date;
}

const DECISIVE_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

/** Per reviewer, the last APPROVED / CHANGES_REQUESTED / DISMISSED review (a later comment never clears a changes request). */
export function latestDecisiveReviews(reviews: readonly ReviewReworkReview[]): ReviewReworkReview[] {
  const latest = new Map<string, ReviewReworkReview>();
  for (const review of reviews) {
    const key = review.login.trim().toLowerCase();
    if (key === '' || !DECISIVE_STATES.has(review.state)) continue;
    latest.set(key, review);
  }
  return [...latest.values()];
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function pollPull(
  opts: PollReviewReworkOptions,
  pull: ReviewReworkPull,
  issue: number,
): Promise<ReviewReworkPollResult | null> {
  const { github, queue, owner, repo, store } = opts;
  const pending = latestDecisiveReviews(await github.listReviews(pull.number)).filter(
    (r) => r.state === 'CHANGES_REQUESTED' && !store.has(r.id),
  );
  const trusted: ReviewReworkReview[] = [];
  for (const review of pending) {
    if (
      await isTrustedApprover(review.login, {
        owner,
        repo,
        trustedApprovers: opts.trustedApprovers,
        client: opts.permissions,
      })
    ) {
      trusted.push(review);
    }
  }
  if (trusted.length === 0) return null;
  const reviewIds = trusted.map((r) => r.id);
  const skipped = (detail: string): ReviewReworkPollResult => ({
    pr: pull.number,
    issue,
    outcome: 'skipped',
    reviewIds,
    detail,
  });

  const labels = await queue.getIssueLabels({ owner, repo, issue_number: issue });
  if (labels.includes(IN_PROGRESS_LABEL)) return skipped('claimed');
  if (labels.includes(PARKED_LABEL)) return skipped('parked');
  const lanes = labels.filter((l) => l.startsWith(LANE_LABEL_PREFIX)).map((l) => l.slice(LANE_LABEL_PREFIX.length));
  if (lanes.length === 0) return skipped('no lane label');
  if (lanes.length > 1) return skipped(`several lane labels: ${lanes.join(', ')}`);
  const lane = lanes[0] ?? '';

  const [res] = await createEnqueuers(queue, owner, repo).enqueue(lane, [issue]);
  if (res === undefined || res.outcome === 'failed') {
    return {
      pr: pull.number,
      issue,
      outcome: 'error',
      reviewIds,
      lane,
      detail: res?.detail ?? 'enqueue returned nothing',
    };
  }
  const queuedAt = (opts.now ?? (() => new Date()))().toISOString();
  for (const review of trusted) {
    store.record({ reviewId: review.id, pr: pull.number, issue, lane, reviewer: review.login, queuedAt });
  }
  return { pr: pull.number, issue, outcome: res.outcome, reviewIds, reviewer: trusted[0]?.login, lane };
}

export async function pollReviewRework(opts: PollReviewReworkOptions): Promise<ReviewReworkPollResult[]> {
  const results: ReviewReworkPollResult[] = [];
  const pulls = await opts.github.listOpenPulls();
  for (const pull of pulls) {
    const issue = factoryBranchIssue(pull.headRef, opts.branchPrefix);
    if (issue === null || pull.headRepo !== `${opts.owner}/${opts.repo}`) continue;
    try {
      const result = await pollPull(opts, pull, issue);
      if (result) results.push(result);
    } catch (err) {
      results.push({ pr: pull.number, issue, outcome: 'error', reviewIds: [], detail: errorMessage(err) });
    }
  }
  return results;
}

export function createOctokitReviewReworkGitHub(octokit: Octokit, owner: string, repo: string): ReviewReworkGitHub {
  return {
    async listOpenPulls() {
      const pulls = await octokit.paginate(octokit.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 });
      return pulls.map((p) => ({ number: p.number, headRef: p.head.ref, headRepo: p.head.repo?.full_name }));
    },
    async listReviews(pull_number) {
      const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number,
        per_page: 100,
      });
      return reviews.map((r) => ({
        id: r.id,
        state: r.state,
        login: r.user?.login ?? '',
        submittedAt: r.submitted_at ?? undefined,
      }));
    },
  };
}

export function createFileReviewReworkStore(file: string): ReviewReworkStore {
  let entries: Map<number, ReviewReworkRecord> | null = null;
  const load = (): Map<number, ReviewReworkRecord> => {
    if (entries) return entries;
    entries = new Map();
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const list = typeof parsed === 'object' && parsed !== null && 'reviews' in parsed ? parsed.reviews : undefined;
      if (Array.isArray(list)) {
        for (const item of list) {
          if (isRecord(item)) entries.set(item.reviewId, item);
        }
      }
    } catch {
      // missing file or bad JSON reads as empty
    }
    return entries;
  };
  const persist = (map: Map<number, ReviewReworkRecord>): void => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ reviews: [...map.values()] }, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  };
  return {
    has: (reviewId) => load().has(reviewId),
    list: () => [...load().values()],
    record(entry) {
      const map = load();
      map.set(entry.reviewId, entry);
      persist(map);
    },
    markStarted(reviewId, at) {
      const map = load();
      const entry = map.get(reviewId);
      if (!entry) return;
      map.set(reviewId, { ...entry, startedAt: at });
      persist(map);
    },
  };
}

/** Claim the newest unstarted record for the issue (by queuedAt, then reviewId) and stamp startedAt on it (#3564). */
export function claimReviewRework(
  store: ReviewReworkStore,
  issue: number,
  now: () => Date = () => new Date(),
): ReviewReworkRecord | undefined {
  const pending = store.list().filter((r) => r.issue === issue && !r.startedAt);
  pending.sort((a, b) => (a.queuedAt === b.queuedAt ? b.reviewId - a.reviewId : a.queuedAt < b.queuedAt ? 1 : -1));
  const picked = pending[0];
  if (!picked) return undefined;
  const startedAt = now().toISOString();
  store.markStarted(picked.reviewId, startedAt);
  return { ...picked, startedAt };
}

function isRecord(value: unknown): value is ReviewReworkRecord {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'reviewId' in value &&
    typeof value.reviewId === 'number' &&
    'pr' in value &&
    typeof value.pr === 'number' &&
    'issue' in value &&
    typeof value.issue === 'number' &&
    'lane' in value &&
    typeof value.lane === 'string' &&
    'reviewer' in value &&
    typeof value.reviewer === 'string' &&
    'queuedAt' in value &&
    typeof value.queuedAt === 'string'
  );
}
