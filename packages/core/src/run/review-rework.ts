// packages/core/src/run/review-rework.ts — review rework: BUILD rework on the PR branch from one review's comments, then CHECK (#3564)
import type { Octokit } from '@octokit/rest';

import { reworkWorker, type checkPhase } from '../phases/check.js';
import type { CheckSummary } from '../types/index.js';
import { UNTRUSTED_REVIEW_FEEDBACK_NOTICE, wrapUntrustedReviewFeedback } from '../utils/untrusted-input.js';
import type { RunPorts, RunRequest } from './run-issue.js';

export interface ReviewReworkTarget {
  prNumber: number;
  reviewId: number;
  reviewer: string;
}

export interface ReviewFeedback {
  prNumber: number;
  reviewId: number;
  reviewer: string;
  state: string;
  body: string;
  comments: { path: string; line?: number; body: string; author: string }[];
}

export class ReviewReworkError extends Error {
  override name = 'ReviewReworkError';
}

const REVIEW_FEEDBACK_MAX_CHARS = 20_000;

export const REVIEW_REWORK_INSTRUCTIONS =
  "This round addresses a reviewer's change request on the open PR, not a checker failure. " +
  'Make the changes each review comment asks for, scoped to the files and lines it names. ' +
  'Do not change code the review does not ask about. If a comment conflicts with the spec, follow the spec and say so in the commit message.';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Review R's body plus only the inline comments that belong to R (filtered by pull_request_review_id). */
export async function fetchReviewFeedback(
  octokit: Pick<Octokit, 'rest' | 'paginate'>,
  opts: { owner: string; repo: string; prNumber: number; reviewId: number },
): Promise<ReviewFeedback> {
  const { owner, repo, prNumber, reviewId } = opts;
  const { data: review } = await octokit.rest.pulls.getReview({
    owner,
    repo,
    pull_number: prNumber,
    review_id: reviewId,
  });
  const all = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  return {
    prNumber,
    reviewId,
    reviewer: review.user?.login ?? '',
    state: review.state,
    body: review.body ?? '',
    comments: all
      .filter((c) => c.pull_request_review_id === reviewId)
      .map((c) => ({
        path: c.path,
        line: c.line ?? c.original_line ?? undefined,
        body: c.body,
        author: c.user?.login ?? '',
      })),
  };
}

export function renderReviewFeedback(feedback: ReviewFeedback): string {
  const comments =
    feedback.comments.length === 0
      ? ['(no inline comments)']
      : feedback.comments.map(
          (c) => `- ${c.path}${c.line === undefined ? '' : `:${c.line}`} (@${c.author}):\n  ${c.body}`,
        );
  let inner = [
    `Review ${feedback.reviewId} by @${feedback.reviewer} (${feedback.state}) on PR #${feedback.prNumber}:`,
    feedback.body === '' ? '(no review body)' : feedback.body,
    'Inline comments:',
    ...comments,
  ].join('\n');
  if (inner.length > REVIEW_FEEDBACK_MAX_CHARS) {
    inner = `${inner.slice(0, REVIEW_FEEDBACK_MAX_CHARS)}\n… (review truncated)`;
  }
  return `${UNTRUSTED_REVIEW_FEEDBACK_NOTICE}\n${wrapUntrustedReviewFeedback(inner)}`;
}

/** The review as a one-result CheckSummary, the same shape ciReworkSummary gives the rework worker. */
export function reviewReworkSummary(feedback: ReviewFeedback): CheckSummary {
  return {
    failures: 1,
    passes: 0,
    skips: 0,
    total: 1,
    results: [{ checker: 'review_feedback', result: 'FAIL', details: renderReviewFeedback(feedback) }],
  };
}

/** A synthetic CHECK resume: skips PLAN and BUILD for a review-rework run. */
export function reviewReworkResume(
  request: Pick<RunRequest, 'reviewRework' | 'preferredRoute' | 'modelPins'>,
): NonNullable<RunRequest['resumeFrom']> | undefined {
  if (!request.reviewRework) return undefined;
  return {
    phase: 'check',
    route: request.preferredRoute ?? 'claude',
    model: request.modelPins.build ?? '',
    buildMinutes: 0,
  };
}

export async function runReviewReworkBuild(opts: {
  target: ReviewReworkTarget;
  repo: string;
  branch: string;
  octokit: Pick<Octokit, 'rest' | 'paginate'>;
  checkOpts: Parameters<typeof checkPhase>[0];
  rework?: typeof reworkWorker;
}): Promise<{ feedback: ReviewFeedback }> {
  const { target, repo, branch, octokit, checkOpts, rework = reworkWorker } = opts;
  const [owner = '', name = ''] = repo.split('/');
  const where = `PR #${target.prNumber} / review ${target.reviewId}`;
  let feedback: ReviewFeedback;
  try {
    const { data: pull } = await octokit.rest.pulls.get({ owner, repo: name, pull_number: target.prNumber });
    if (pull.state !== 'open' || pull.head.ref !== branch) {
      throw new ReviewReworkError(
        `PR #${target.prNumber} must be open with head ${branch}; found ${pull.state} with head ${pull.head.ref}`,
      );
    }
    feedback = await fetchReviewFeedback(octokit, {
      owner,
      repo: name,
      prNumber: target.prNumber,
      reviewId: target.reviewId,
    });
  } catch (err) {
    if (err instanceof ReviewReworkError) throw err;
    throw new ReviewReworkError(`could not read ${where}: ${errorMessage(err)}`, { cause: err });
  }
  checkOpts.log(
    'rework',
    `review rework: PR #${target.prNumber} review ${target.reviewId} by @${target.reviewer} — ${feedback.comments.length} inline comment(s) on ${branch}`,
  );
  const worked = await rework({
    issue: checkOpts.issue,
    worktree: checkOpts.worktree,
    specPath: checkOpts.specPath,
    summary: reviewReworkSummary(feedback),
    constitution: checkOpts.constitution,
    router: checkOpts.router,
    log: checkOpts.log,
    buildTimeoutSeconds: checkOpts.buildTimeoutSeconds,
    sandbox: checkOpts.sandbox,
    appPort: checkOpts.appPort,
    appBaseUrl: checkOpts.appBaseUrl,
    onPgid: checkOpts.onPgid,
    budgetGuard: checkOpts.budgetGuard,
    reworkRoute: checkOpts.reworkRoute,
    reworkModel: checkOpts.reworkModel,
    runId: checkOpts.runId,
    onWorkerResult: checkOpts.onWorkerResult,
    extraInstructions: REVIEW_REWORK_INSTRUCTIONS,
  });
  if (!worked.modelCompleted) {
    throw new ReviewReworkError(
      `review rework worker never ran for ${where}${worked.failureReason ? `: ${worked.failureReason}` : ''}`,
    );
  }
  return { feedback };
}

/** runIssue's hook before the first CHECK: reworks the requested review unless a CHECK resume was asked for. */
export async function runRequestedReviewRework(
  request: Pick<RunRequest, 'reviewRework' | 'resumeFrom' | 'repo' | 'branch'>,
  ports: Pick<RunPorts, 'octokit' | 'reworkWorker'>,
  checkOpts: Parameters<typeof checkPhase>[0],
): Promise<void> {
  if (!request.reviewRework || request.resumeFrom) return;
  await runReviewReworkBuild({
    target: request.reviewRework,
    repo: request.repo,
    branch: request.branch,
    octokit: ports.octokit,
    checkOpts,
    rework: ports.reworkWorker,
  });
}
