// packages/core/src/internal-ci.ts — the CI watch, awaiting-ci and required-checks names of ./internal, split out to keep internal.ts under its line ceiling

export type { CiOutcome, InfraRerunOutcome, WatchChecksOptions } from './utils/ci-watch.js';
export type { AwaitingCiRecord } from './utils/awaiting-ci.js';
export {
  awaitingCiFile,
  clearAwaitingCi,
  nextRecheckAt,
  readAwaitingCi,
  resolveAwaitingCiCapMs,
  upsertAwaitingCi,
} from './utils/awaiting-ci.js';
export { hasAnyCiSignal, listAllCheckRuns, watchChecks, watchChecksWithInfraRerun } from './utils/ci-watch.js';
export type { RequiredChecksState } from './utils/required-checks.js';
export { classifyHeadChecks, fetchRequiredContexts, warnNoBranchProtectionOnce } from './utils/required-checks.js';
