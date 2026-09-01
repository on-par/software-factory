// packages/scbench-adapter/src/index.ts — public API of @on-par/scbench-adapter.
export type { CheckpointResult, ScbenchCheckpoint } from './checkpoint.js';
export { AdapterError } from './checkpoint.js';

export { materializeBrief } from './brief.js';

export type { ExecFn, ExecResult, WorkspaceDeps } from './workspace.js';
export { commitCheckpoint, createExecaExec, prepareWorkspace } from './workspace.js';

export type { BuildRunBriefArgsOptions, RunFactoryOptions } from './invoke.js';
export { buildRunBriefArgs, runFactory } from './invoke.js';

export type { ArtifactsFsDeps, CollectArtifactsOptions, CollectArtifactsResult } from './artifacts.js';
export { collectArtifacts, NATIVE_EVIDENCE_FILES } from './artifacts.js';

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
  TrialVerdict,
} from './baseline.js';
export { collectBaselineTrials, evaluateTrialVerdict, generateBaselineReport, loadBaselineConfig } from './baseline.js';

export type { PinFile, PinnedInputSpec, PinPreflightOutcome, PinPreflightResult } from './pin-preflight.js';
export { checkPinnedInput, parsePinFile, runPinPreflight } from './pin-preflight.js';

export type {
  CatalogPreflightDeps,
  CatalogPreflightOutcome,
  CatalogPreflightResult,
  CatalogPreflightSpec,
} from './catalog-preflight.js';
export { runCatalogPreflight } from './catalog-preflight.js';
