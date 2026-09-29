// packages/core/src/review/containment.ts — fail-closed fork-PR containment gate (#1684).

import type { ContainerEngine } from '../hosted/container.js';

/** Exit code for a review refused because containment is required but unavailable. */
export const REVIEW_CONTAINMENT_REFUSED_EXIT_CODE = 2;

export interface ReviewPullRequestRepos {
  /** PR number, used only in the refusal message. */
  number: number;
  /** Base repository `owner/name`. */
  baseRepo: string;
  /** Head repository `owner/name`; null/empty when unknown (e.g. deleted fork) — treated as a fork. */
  headRepo: string | null;
}

export type ReviewContainmentDecision =
  | { kind: 'host' }
  | { kind: 'contained' }
  | { kind: 'refused'; exitCode: typeof REVIEW_CONTAINMENT_REFUSED_EXIT_CODE; message: string };

export interface ContainmentGatedReviewDeps {
  pr: ReviewPullRequestRepos;
  engine: ContainerEngine;
  /** Today's same-repo review: checkout + checkers on the host. Called only for same-repo PRs. */
  runOnHost: () => Promise<{ exitCode: number }>;
  /** Contained review (#1685). When absent, a fork PR is refused rather than run on the host. */
  runContained?: () => Promise<{ exitCode: number }>;
  /** Sink for the refusal message (the CLI passes stderr). */
  write: (line: string) => void;
}

const DOCKER_UNAVAILABLE_WHY = 'Docker is not available (start Docker and re-run)';
const NO_RUNNER_WHY = 'contained review is not supported yet (#1685)';

export function isForkPullRequest(pr: ReviewPullRequestRepos): boolean {
  const head = pr.headRepo?.trim();
  if (!head) return true;
  return head.toLowerCase() !== pr.baseRepo.trim().toLowerCase();
}

async function probeAvailable(engine: ContainerEngine): Promise<boolean> {
  if (!engine.isAvailable) return false;
  try {
    return (await engine.isAvailable()) === true;
  } catch {
    return false;
  }
}

function refusal(pr: ReviewPullRequestRepos, why: string): string {
  return `review refused: PR #${pr.number} comes from ${pr.headRepo?.trim() || 'an unknown head repository'}, not ${pr.baseRepo} — containment is required to review a fork PR, and ${why}. No fork code was checked out and no checker ran.`;
}

export async function resolveReviewContainment(
  pr: ReviewPullRequestRepos,
  engine: ContainerEngine,
): Promise<ReviewContainmentDecision> {
  if (!isForkPullRequest(pr)) return { kind: 'host' };
  if (!(await probeAvailable(engine))) {
    return {
      kind: 'refused',
      exitCode: REVIEW_CONTAINMENT_REFUSED_EXIT_CODE,
      message: refusal(pr, DOCKER_UNAVAILABLE_WHY),
    };
  }
  return { kind: 'contained' };
}

export async function runContainmentGatedReview(deps: ContainmentGatedReviewDeps): Promise<{ exitCode: number }> {
  const decision = await resolveReviewContainment(deps.pr, deps.engine);
  if (decision.kind === 'host') return deps.runOnHost();
  if (decision.kind === 'refused') {
    deps.write(decision.message);
    return { exitCode: decision.exitCode };
  }
  if (deps.runContained) return deps.runContained();
  deps.write(refusal(deps.pr, NO_RUNNER_WHY));
  return { exitCode: REVIEW_CONTAINMENT_REFUSED_EXIT_CODE };
}
