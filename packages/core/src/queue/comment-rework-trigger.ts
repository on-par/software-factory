// packages/core/src/queue/comment-rework-trigger.ts — a trusted `/factory rework <feedback>` PR comment queues a review rework on the same PR branch, once per comment id, counted against the review-rework cap (#3882, ADR-0128 trust).
import { defaultFactoryConfig } from '@on-par/factory-config';

import type { ParkCommentInput } from '../run/park-comment.js';
import { countReviewReworkRuns, parkAtReviewReworkCap } from '../run/review-rework-cap.js';
import { factoryBranchIssue } from '../utils/index.js';
import { workKeyFromIssue } from '../work/work-key.js';
import { isTrustedApprover, type CollaboratorPermissionClient } from './approval.js';
import { IN_PROGRESS_LABEL, LANE_LABEL_PREFIX, PARKED_LABEL, type QueueGitHubClient } from './github-queue.js';
import { createEnqueuers } from './github-queue-enqueue.js';
import type { IterateComment, IterateCommandGitHub, IteratePull } from './iterate-command.js';
import type { ReviewReworkPollResult, ReviewReworkStore } from './review-rework-trigger.js';

/** The feedback after `/factory rework` (rest of the first non-blank line plus later lines); null when the comment is not the command. */
export function parseReworkCommand(body: string): string | null {
  const lines = body.split(/\r?\n/);
  const at = lines.findIndex((line) => line.trim() !== '');
  if (at < 0) return null;
  const match = /^\/factory rework(?:\s+|$)/i.exec((lines[at] ?? '').trim());
  if (!match) return null;
  const first = (lines[at] ?? '').trim().slice(match[0].length);
  return [first, ...lines.slice(at + 1)].join('\n').trim();
}

export interface PollCommentReworkOptions {
  github: IterateCommandGitHub;
  queue: QueueGitHubClient;
  owner: string;
  repo: string;
  branchPrefix?: string;
  trustedApprovers?: readonly string[];
  permissions: CollaboratorPermissionClient;
  store: ReviewReworkStore;
  now?: () => Date;
  /** Review-rework runs allowed per issue (#3565); defaults to the shipped default. */
  maxRuns?: number;
  /** Upserting park-comment publisher; without it the cap comment is a plain issue comment. */
  publishParkComment?: (input: Omit<ParkCommentInput, 'parkSha' | 'order'>) => Promise<unknown>;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function pollPull(
  opts: PollCommentReworkOptions,
  pull: IteratePull,
  issue: number,
): Promise<ReviewReworkPollResult | null> {
  const { github, queue, owner, repo, store } = opts;
  const pending = (await github.listComments(pull.number)).filter(
    (c) => parseReworkCommand(c.body) !== null && !store.has(c.id, 'comment'),
  );
  const trusted: IterateComment[] = [];
  for (const comment of pending) {
    const ok = await isTrustedApprover(comment.login, {
      owner,
      repo,
      trustedApprovers: opts.trustedApprovers,
      client: opts.permissions,
    });
    if (ok) trusted.push(comment);
  }
  const newest = trusted.reduce<IterateComment | undefined>(
    (a, c) => (a === undefined || c.id > a.id ? c : a),
    undefined,
  );
  if (newest === undefined) return null;
  const reviewIds = trusted.map((c) => c.id);
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const recordAll = (lane: string, extra: { cappedAt?: string }): void => {
    for (const c of trusted) {
      store.record({
        reviewId: c.id,
        source: 'comment',
        pr: pull.number,
        issue,
        lane,
        reviewer: c.login,
        queuedAt: now,
        ...extra,
      });
    }
  };
  const result = (
    outcome: ReviewReworkPollResult['outcome'],
    extra: Partial<ReviewReworkPollResult> = {},
  ): ReviewReworkPollResult => ({
    pr: pull.number,
    issue,
    outcome,
    reviewIds,
    reviewer: newest.login,
    ...extra,
  });

  if ((parseReworkCommand(newest.body) ?? '') === '') {
    await github.postComment(pull.number, 'Factory rework: rejected — add the feedback after `/factory rework`.');
    recordAll('', { cappedAt: now });
    return result('skipped', { detail: 'no feedback' });
  }

  const labels = await queue.getIssueLabels({ owner, repo, issue_number: issue });
  if (labels.includes(IN_PROGRESS_LABEL)) return result('skipped', { detail: 'claimed' });
  if (labels.includes(PARKED_LABEL)) return result('skipped', { detail: 'parked' });
  const lanes = labels.filter((l) => l.startsWith(LANE_LABEL_PREFIX)).map((l) => l.slice(LANE_LABEL_PREFIX.length));
  if (lanes.length === 0) return result('skipped', { detail: 'no lane label' });
  if (lanes.length > 1) return result('skipped', { detail: `several lane labels: ${lanes.join(', ')}` });
  const lane = lanes[0] ?? '';

  const cap = opts.maxRuns ?? defaultFactoryConfig.queue.max_review_rework_runs;
  const key = workKeyFromIssue(issue);
  const count = countReviewReworkRuns(store, key);
  if (count >= cap) {
    // Record first so a park that fails part-way is not commented on again by the next poll.
    recordAll(lane, { cappedAt: now });
    await parkAtReviewReworkCap({
      queue,
      owner,
      repo,
      issue: key,
      pr: pull.number,
      lane,
      branch: pull.headRef,
      cap,
      count,
      reviewIds,
      source: 'comment',
      publishComment: opts.publishParkComment,
    });
    await github.postComment(
      pull.number,
      `Factory rework: not queued — #${issue} has used its review-rework limit (${count}/${cap}, queue.max_review_rework_runs). The issue is parked.`,
    );
    return result('capped', { lane, cap, count });
  }

  const [res] = await createEnqueuers(queue, owner, repo).enqueue(lane, [issue]);
  if (res === undefined || res.outcome === 'failed') {
    return result('error', { lane, detail: res?.detail ?? 'enqueue returned nothing' });
  }
  recordAll(lane, {});
  await github.postComment(
    pull.number,
    `Factory rework: queued #${issue} on lane '${lane}'. The next run reworks this comment's feedback on \`${pull.headRef}\` and pushes to this PR. No new PR is opened.`,
  );
  return result(res.outcome, { lane });
}

export async function pollCommentRework(opts: PollCommentReworkOptions): Promise<ReviewReworkPollResult[]> {
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
