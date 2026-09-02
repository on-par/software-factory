// packages/scbench-adapter/src/retry-context.ts — failed-evaluation → structured retry context (#1163).
import type { ScbenchEvaluation } from './baseline.js';

/** Pinned pass policy id, mirroring baseline.config.json / ADR-0007. */
export const RETRY_PASS_POLICY = 'core-cases';

const EXCERPT_LIMIT = 2000;

export interface FailedTest {
  group: string;
  name: string;
}

/** Structured evidence handed to Factory's rework attempt for one failed checkpoint. */
export interface ScbenchRetryContext {
  problemId: string;
  checkpointId: string;
  passPolicy: string;
  pytestExitCode: number;
  failedTests: FailedTest[];
  stdoutExcerpt?: string;
  stderrExcerpt?: string;
}

/** Human-readable reason an evaluation must NOT be retried, or `undefined`
 *  when it is retryable. Mirrors evaluateTrialVerdict: an infrastructure
 *  failure is a provider fault (not a code fault), and a passing Core group
 *  (vacuous 0/0 counts as equal, matching upstream PassPolicy.CORE_CASES)
 *  leaves nothing to rework. */
export function retrySkipReason(evaluation: ScbenchEvaluation): string | undefined {
  if (evaluation.infrastructure_failure) {
    return 'infrastructure failure — provider fault, not a code fault';
  }
  if ((evaluation.pass_counts.Core ?? 0) === (evaluation.total_counts.Core ?? 0)) {
    return `checkpoint passed under pass policy ${RETRY_PASS_POLICY} — nothing to rework`;
  }
  return undefined;
}

/** First EXCERPT_LIMIT chars, with an explicit truncation marker when longer
 *  — never a silently clipped excerpt. */
function excerpt(s: string): string {
  return s.length > EXCERPT_LIMIT ? `${s.slice(0, EXCERPT_LIMIT)}\n… [truncated]` : s;
}

/** Flatten a failed evaluation into the structured context the rework brief
 *  renders: one {group, name} entry per failed test, groups in insertion
 *  order; stdout/stderr excerpts only when the evidence actually carries
 *  them — never synthesized. */
export function buildRetryContext(evaluation: ScbenchEvaluation): ScbenchRetryContext {
  const failedTests: FailedTest[] = [];
  for (const [group, outcomes] of Object.entries(evaluation.tests ?? {})) {
    for (const name of outcomes.failed) {
      failedTests.push({ group, name });
    }
  }

  const ctx: ScbenchRetryContext = {
    problemId: evaluation.problem_name,
    checkpointId: evaluation.checkpoint_name,
    passPolicy: RETRY_PASS_POLICY,
    pytestExitCode: evaluation.pytest_exit_code,
    failedTests,
  };
  if (evaluation.stdout !== undefined && evaluation.stdout.length > 0) ctx.stdoutExcerpt = excerpt(evaluation.stdout);
  if (evaluation.stderr !== undefined && evaluation.stderr.length > 0) ctx.stderrExcerpt = excerpt(evaluation.stderr);
  return ctx;
}
