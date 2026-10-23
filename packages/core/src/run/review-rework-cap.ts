// packages/core/src/run/review-rework-cap.ts — cap review-rework runs per issue and park at the cap (#3565)
import { defaultFactoryConfig } from '@on-par/factory-config';

import type { FactoryConfig } from '../config/index.js';
import { PARKED_LABEL, queueLabelSpecs, type QueueGitHubClient } from '../queue/github-queue.js';
import type { ReviewReworkStore } from '../queue/review-rework-trigger.js';
import { renderParkComment, type ParkCommentInput } from './park-comment.js';

/** Review-rework runs allowed per issue, from validated config (#3565). */
export function resolveMaxReviewReworkRuns(config: Pick<FactoryConfig, 'queue'>): number {
  return config.queue?.max_review_rework_runs ?? defaultFactoryConfig.queue.max_review_rework_runs;
}

/** Review-rework runs the issue has had: records a lane claimed (startedAt set). */
export function countReviewReworkRuns(store: Pick<ReviewReworkStore, 'list'>, issue: number): number {
  return store.list().filter((r) => r.issue === issue && r.startedAt).length;
}

export function reviewReworkCapMessage(input: {
  issue: number;
  pr: number;
  cap: number;
  count: number;
  reviewIds: readonly number[];
}): string {
  const { issue, pr, cap, count, reviewIds } = input;
  return `review rework cap reached: #${issue} has had ${count} review-rework runs (cap ${cap}, queue.max_review_rework_runs). Review ${reviewIds.join(', ')} on PR #${pr} started no run. Address it by hand or raise the cap, then run \`factory unpark ${issue}\`.`;
}

/** Add factory:parked and write one park comment naming the cap and the count. */
export async function parkAtReviewReworkCap(deps: {
  queue: QueueGitHubClient;
  owner: string;
  repo: string;
  issue: number;
  pr: number;
  lane: string;
  branch: string;
  cap: number;
  count: number;
  reviewIds: readonly number[];
  publishComment?: (input: Omit<ParkCommentInput, 'parkSha' | 'order'>) => Promise<unknown>;
}): Promise<void> {
  const { queue, owner, repo, issue } = deps;
  const spec = queueLabelSpecs('release', '-').find((s) => s.name === PARKED_LABEL);
  if (spec) await queue.ensureLabel({ owner, repo, ...spec });
  await queue.addLabels({ owner, repo, issue_number: issue, labels: [PARKED_LABEL] });
  const input = {
    issue,
    reason: 'escalate' as const,
    message: reviewReworkCapMessage(deps),
    runId: '-',
    branch: deps.branch,
    lane: deps.lane,
  };
  if (deps.publishComment) {
    const res = await deps.publishComment(input);
    if (typeof res === 'object' && res !== null && 'ok' in res && res.ok === false) {
      throw new Error('error' in res && typeof res.error === 'string' ? res.error : 'park comment failed');
    }
    return;
  }
  await queue.createIssueComment({ owner, repo, issue_number: issue, body: renderParkComment(input) });
}
