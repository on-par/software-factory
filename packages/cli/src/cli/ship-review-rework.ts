import { claimReviewRework, createFileReviewReworkStore } from '@on-par/factory-core/internal';

type Log = (type: 'rework', message: string) => void;

/** Claim a queued review rework for the issue; returns the request fragment to spread into the run request (#3564). */
export function claimReviewReworkRequest(
  reviewReworkFile: string,
  issueNum: number,
  skip: unknown,
  log: Log,
): { reviewRework?: { prNumber: number; reviewId: number; reviewer: string } } {
  const record = skip ? undefined : claimReviewRework(createFileReviewReworkStore(reviewReworkFile), issueNum);
  if (!record) return {};
  log(
    'rework',
    `review rework of PR #${record.pr} review ${record.reviewId} by @${record.reviewer} — PLAN and BUILD skipped (#3564)`,
  );
  return { reviewRework: { prNumber: record.pr, reviewId: record.reviewId, reviewer: record.reviewer } };
}
