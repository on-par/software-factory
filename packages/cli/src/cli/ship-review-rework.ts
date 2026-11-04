import {
  claimIterateCommand,
  claimReviewRework,
  createFileIterateStore,
  createFileReviewReworkStore,
} from '@on-par/factory-core/internal';
import type { ReviewReworkSource } from '@on-par/factory-core/internal';

type Log = (type: 'rework', message: string) => void;

/** Claim a queued review rework for the issue; returns the request fragment to spread into the run request (#3564). */
export function claimReviewReworkRequest(
  reviewReworkFile: string,
  issueNum: number,
  skip: unknown,
  log: Log,
): {
  reviewRework?: {
    prNumber: number;
    reviewId: number;
    reviewer: string;
    source?: Extract<ReviewReworkSource, 'comment'>;
  };
  /** The queued run also answers every unhandled trusted PR comment (#3910). */
  feedbackRound?: { prNumber: number };
} {
  const record = skip ? undefined : claimReviewRework(createFileReviewReworkStore(reviewReworkFile), issueNum);
  if (!record) return {};
  const comment = record.source === 'comment';
  log(
    'rework',
    `review rework of PR #${record.pr} ${comment ? 'comment' : 'review'} ${record.reviewId} by @${record.reviewer} — PLAN and BUILD skipped (#3564)`,
  );
  return {
    reviewRework: {
      prNumber: record.pr,
      reviewId: record.reviewId,
      reviewer: record.reviewer,
      ...(comment ? { source: 'comment' as const } : {}),
    },
    feedbackRound: { prNumber: record.pr },
  };
}

/** Claim a queued `/factory iterate` for the issue; returns the request fragment to spread into the run request (#3625). */
export function claimIterateRequest(
  iterateFile: string,
  issueNum: number,
  skip: unknown,
  log: Log,
): { iterate?: { prNumber: number; commentId: number; actor: string } } {
  const record = skip ? undefined : claimIterateCommand(createFileIterateStore(iterateFile), issueNum);
  if (!record) return {};
  log(
    'rework',
    `iterate of PR #${record.pr} by @${record.actor} (comment ${record.commentId}) — PLAN and BUILD skipped (#3625)`,
  );
  return { iterate: { prNumber: record.pr, commentId: record.commentId, actor: record.actor } };
}

/** Claim whichever rework trigger is queued for the issue; a review rework wins and leaves any iterate record pending. */
export function claimReworkRequests(
  paths: { reviewRework: string; iterate: string },
  issueNum: number,
  skip: unknown,
  log: Log,
): ReturnType<typeof claimReviewReworkRequest> & ReturnType<typeof claimIterateRequest> {
  const reviewRework = claimReviewReworkRequest(paths.reviewRework, issueNum, skip, log);
  return reviewRework.reviewRework ? reviewRework : claimIterateRequest(paths.iterate, issueNum, skip, log);
}
