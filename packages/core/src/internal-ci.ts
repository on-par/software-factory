// packages/core/src/internal-ci.ts — the CI watch, awaiting-ci and required-checks names of ./internal, split out to keep internal.ts under its line ceiling

export type {
  CiFailureClass,
  CiJobLike,
  CiJobStepLike,
  CiNoChecksInfo,
  CiOutcome,
  CiRerunBudget,
  CiRescue,
  CiRescueFailure,
  CiWatchProgress,
  InfraRerunOutcome,
  InfraRerunWatchOptions,
  WatchChecksOptions,
} from './utils/ci-watch.js';
export type { AwaitingCiRecord } from './utils/awaiting-ci.js';
export {
  awaitingCiFile,
  clearAwaitingCi,
  nextRecheckAt,
  readAwaitingCi,
  resolveAwaitingCiCapMs,
  upsertAwaitingCi,
} from './utils/awaiting-ci.js';
export { collectCiFailureEvidence } from './utils/ci-evidence.js';
export {
  classifyCiFailure,
  DEFAULT_CI_DEADLINE_MS,
  DEFAULT_CI_NO_CHECKS_GRACE_MS,
  hasAnyCiSignal,
  isPassingConclusion,
  listAllCheckRuns,
  noChecksVerdictMs,
  resolveCiNoChecksGraceMs,
  watchChecks,
  watchChecksWithInfraRerun,
} from './utils/ci-watch.js';
export type { RequiredChecksState } from './utils/required-checks.js';
export { classifyHeadChecks, fetchRequiredContexts, warnNoBranchProtectionOnce } from './utils/required-checks.js';
