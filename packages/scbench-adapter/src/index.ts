// packages/scbench-adapter/src/index.ts — public API of @on-par/scbench-adapter.
export type { CheckpointResult, ScbenchCheckpoint } from './checkpoint.js';
export { AdapterError } from './checkpoint.js';

export { materializeBrief, materializeRetryBrief } from './brief.js';

export type { FailedTest, ScbenchRetryContext } from './retry-context.js';
export { buildRetryContext, retrySkipReason, RETRY_PASS_POLICY } from './retry-context.js';

export type { RetryCheckpointResult } from './retry-checkpoint.js';
export { retryCheckpoint } from './retry-checkpoint.js';

export type { ExecFn, ExecResult, WorkspaceDeps } from './workspace.js';
export { commitCheckpoint, createExecaExec, prepareWorkspace } from './workspace.js';

export type { BuildRunBriefArgsOptions, RunFactoryOptions } from './invoke.js';
export { buildRunBriefArgs, runFactory } from './invoke.js';

export type { ArtifactsFsDeps, CollectArtifactsOptions, CollectArtifactsResult } from './artifacts.js';
export { collectArtifacts, NATIVE_EVIDENCE_FILES } from './artifacts.js';

export type { CollectTrialOptions, CollectTrialResult } from './collect-trial.js';
export { collectTrial, FACTORY_TRIAL_FILES } from './collect-trial.js';

export type { RunCheckpointDeps, RunCheckpointOptions } from './run-checkpoint.js';
export { runCheckpoint } from './run-checkpoint.js';

export type { CliDeps } from './cli-run.js';
export { defaultCliDeps, main as runCli } from './cli-run.js';

export type {
  BaselineConfig,
  BaselineFsDeps,
  BaselineTrial,
  BaselineTrialEvidence,
  ScbenchEvaluation,
  ScbenchRunRecord,
  ScbenchTestGroup,
  TrialVerdict,
} from './baseline.js';
export {
  collectBaselineTrials,
  evaluateTrialVerdict,
  generateBaselineReport,
  loadBaselineConfig,
  parseEvaluation,
} from './baseline.js';

export type { ComparisonEntry, ComparisonResult, ComparisonSideStats, ComparisonStatus } from './compare.js';
export { compareTrialSets, renderComparisonReport } from './compare.js';

export type { PinFile, PinnedInputSpec, PinPreflightOutcome, PinPreflightResult } from './pin-preflight.js';
export { checkPinnedInput, parsePinFile, runPinPreflight } from './pin-preflight.js';

export type {
  CatalogPreflightDeps,
  CatalogPreflightOutcome,
  CatalogPreflightResult,
  CatalogPreflightSpec,
} from './catalog-preflight.js';
export { runCatalogPreflight } from './catalog-preflight.js';
