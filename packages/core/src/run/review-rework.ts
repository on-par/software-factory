import type { Octokit } from '@octokit/rest';

import { reworkWorker, type checkPhase } from '../phases/check.js';
import type { CheckSummary } from '../types/index.js';
import { parseReworkCommand } from '../queue/comment-rework-trigger.js';
import { UNTRUSTED_REVIEW_FEEDBACK_NOTICE, wrapUntrustedReviewFeedback } from '../utils/untrusted-input.js';
import type { FeedbackRoundPlan, FeedbackRoundTarget } from './feedback-round.js';
import type { RunPorts, RunRequest } from './run-issue.js';

export interface ReviewReworkTarget {
  prNumber: number;
  reviewId: number;
  reviewer: string;
  source?: 'comment';
}

export interface IterateTarget {
  prNumber: number;
  commentId: number;
  actor: string;
}

export interface ReworkRequestFields {
  reviewRework?: ReviewReworkTarget;
  iterate?: IterateTarget;
  feedbackRound?: FeedbackRoundTarget;
  trustedApprovers?: readonly string[];
}

export interface ReviewFeedback {
  prNumber: number;
  reviewId: number;
  reviewer: string;
  state: string;
  body: string;
  comments: { path: string; line?: number; body: string; author: string }[];
  source?: 'comment';
}

export class ReviewReworkError extends Error {
  override name = 'ReviewReworkError';
}

const REVIEW_FEEDBACK_MAX_CHARS = 20_000;

export const REVIEW_REWORK_INSTRUCTIONS =
  "This round addresses a reviewer's change request or feedback comment on the open PR, not a checker failure. " +
  'Make the changes each review comment asks for, scoped to the files and lines it names. ' +
  'Do not change code the review does not ask about. If a comment conflicts with the spec, follow the spec and say so in the commit message.';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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

export async function fetchCommentFeedback(
  octokit: Pick<Octokit, 'rest'>,
  opts: { owner: string; repo: string; prNumber: number; commentId: number },
): Promise<ReviewFeedback> {
  const { owner, repo, prNumber, commentId } = opts;
  const { data: comment } = await octokit.rest.issues.getComment({ owner, repo, comment_id: commentId });
  const feedback = parseReworkCommand(comment.body ?? '');
  if (feedback === null || feedback === '') {
    throw new ReviewReworkError(`comment ${commentId} on PR #${prNumber} is no longer a /factory rework command`);
  }
  return {
    prNumber,
    reviewId: commentId,
    reviewer: comment.user?.login ?? '',
    state: 'COMMENTED',
    body: feedback,
    comments: [],
    source: 'comment',
  };
}

export function renderReviewFeedback(feedback: ReviewFeedback): string {
  const comments =
    feedback.comments.length === 0
      ? ['(no inline comments)']
      : feedback.comments.map(
          (c) => `- ${c.path}${c.line === undefined ? '' : `:${c.line}`} (@${c.author}):\n  ${c.body}`,
        );
  let inner =
    feedback.source === 'comment'
      ? [`Comment ${feedback.reviewId} by @${feedback.reviewer} on PR #${feedback.prNumber}:`, feedback.body].join('\n')
      : [
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

export function reviewReworkSummary(feedback: ReviewFeedback): CheckSummary {
  return {
    failures: 1,
    passes: 0,
    skips: 0,
    total: 1,
    results: [{ checker: 'review_feedback', result: 'FAIL', details: renderReviewFeedback(feedback) }],
  };
}

export function reviewReworkResume(
  request: Pick<
    RunRequest,
    'reviewRework' | 'iterate' | 'feedbackRound' | 'ciReworkResume' | 'preferredRoute' | 'modelPins'
  >,
  feedbackPlan?: Pick<FeedbackRoundPlan, 'replan'>,
): NonNullable<RunRequest['resumeFrom']> | undefined {
  if (feedbackPlan?.replan) return undefined;
  if (!request.reviewRework && !request.iterate && !request.feedbackRound && !request.ciReworkResume) return undefined;
  return {
    phase: 'check',
    route: request.preferredRoute ?? 'claude',
    model: request.modelPins.build ?? '',
    buildMinutes: 0,
  };
}

async function assertOpenPrHead(
  octokit: Pick<Octokit, 'rest'>,
  opts: { owner: string; repo: string; prNumber: number; branch: string },
): Promise<void> {
  const { data: pull } = await octokit.rest.pulls.get({
    owner: opts.owner,
    repo: opts.repo,
    pull_number: opts.prNumber,
  });
  if (pull.state !== 'open' || pull.head.ref !== opts.branch) {
    throw new ReviewReworkError(
      `PR #${opts.prNumber} must be open with head ${opts.branch}; found ${pull.state} with head ${pull.head.ref}`,
    );
  }
}

async function runReworkWorker(
  checkOpts: Parameters<typeof checkPhase>[0],
  summary: CheckSummary,
  where: string,
  rework: typeof reworkWorker,
): Promise<void> {
  const worked = await rework({
    issue: checkOpts.issue,
    worktree: checkOpts.worktree,
    specPath: checkOpts.specPath,
    summary,
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
  const kind = target.source === 'comment' ? 'comment' : 'review';
  const where = `PR #${target.prNumber} / ${kind} ${target.reviewId}`;
  let feedback: ReviewFeedback;
  try {
    await assertOpenPrHead(octokit, { owner, repo: name, prNumber: target.prNumber, branch });
    feedback =
      target.source === 'comment'
        ? await fetchCommentFeedback(octokit, {
            owner,
            repo: name,
            prNumber: target.prNumber,
            commentId: target.reviewId,
          })
        : await fetchReviewFeedback(octokit, {
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
    `review rework: PR #${target.prNumber} ${kind} ${target.reviewId} by @${target.reviewer} — ${feedback.comments.length} inline comment(s) on ${branch}`,
  );
  await runReworkWorker(checkOpts, reviewReworkSummary(feedback), where, rework);
  return { feedback };
}

async function guardIterateTarget(
  target: IterateTarget,
  request: Pick<RunRequest, 'repo' | 'branch'>,
  octokit: Pick<Octokit, 'rest'>,
  checkOpts: Parameters<typeof checkPhase>[0],
): Promise<void> {
  const [owner = '', name = ''] = request.repo.split('/');
  try {
    const { data: pull } = await octokit.rest.pulls.get({ owner, repo: name, pull_number: target.prNumber });
    if (pull.state !== 'open' || pull.head.ref !== request.branch) {
      throw new ReviewReworkError(
        `PR #${target.prNumber} must be open with head ${request.branch}; found ${pull.state} with head ${pull.head.ref}`,
      );
    }
  } catch (err) {
    if (err instanceof ReviewReworkError) throw err;
    throw new ReviewReworkError(`could not read PR #${target.prNumber}: ${errorMessage(err)}`, { cause: err });
  }
  checkOpts.log(
    'rework',
    `iterate: PR #${target.prNumber} by @${target.actor} (comment ${target.commentId}) — re-running CHECK on ${request.branch}`,
  );
}

export async function runRequestedReviewRework(
  request: Pick<RunRequest, 'reviewRework' | 'iterate' | 'feedbackRound' | 'resumeFrom' | 'repo' | 'branch'>,
  ports: Pick<RunPorts, 'octokit' | 'reworkWorker'>,
  checkOpts: Parameters<typeof checkPhase>[0],
  feedbackPlan?: Pick<FeedbackRoundPlan, 'prNumber' | 'summary'>,
): Promise<void> {
  if (request.resumeFrom) return;
  if (feedbackPlan) {
    if (feedbackPlan.summary === undefined) return;
    const where = `PR #${feedbackPlan.prNumber} / feedback round`;
    const [owner = '', name = ''] = request.repo.split('/');
    try {
      await assertOpenPrHead(ports.octokit, {
        owner,
        repo: name,
        prNumber: feedbackPlan.prNumber,
        branch: request.branch,
      });
    } catch (err) {
      if (err instanceof ReviewReworkError) throw err;
      throw new ReviewReworkError(`could not read ${where}: ${errorMessage(err)}`, { cause: err });
    }
    checkOpts.log('rework', `feedback round: reworking PR #${feedbackPlan.prNumber} on ${request.branch}`);
    await runReworkWorker(checkOpts, feedbackPlan.summary, where, ports.reworkWorker ?? reworkWorker);
    return;
  }
  if (!request.reviewRework) {
    if (request.iterate) await guardIterateTarget(request.iterate, request, ports.octokit, checkOpts);
    return;
  }
  await runReviewReworkBuild({
    target: request.reviewRework,
    repo: request.repo,
    branch: request.branch,
    octokit: ports.octokit,
    checkOpts,
    rework: ports.reworkWorker,
  });
}
