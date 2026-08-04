// packages/core/src/sim/index.ts — barrel for the reusable sim harness.

export type { SimFailureMode, SimJitterConfig, SimJitterDraw, SimJitterSeam, SimPhaseJitter } from './jitter.js';
export {
  createSeededRandom,
  deriveSimSeed,
  SIM_FAILURE_MODES,
  SIM_MALFORMED_OUTPUT,
  SimJitter,
  SimJitterExecutor,
  withSimJitter,
} from './jitter.js';
export type { SimClock, SimLatency } from './latency.js';
export { applyLatency, realSimClock, resolveLatencyMs } from './latency.js';
export type { SimModelCall, SimModelExecutorOptions, SimModelStep } from './model.js';
export { failOnCall, SimModelExecutor } from './model.js';
export type { SimOctokit, SimOctokitEndpoint, SimOctokitOptions, SimOctokitStep, SimRecordedCall } from './octokit.js';
export { createSimOctokit } from './octokit.js';
export type {
  SimIssueOutcome,
  SimIssueSpec,
  SimPipelineEvent,
  SimulationOptions,
  SimulationReport,
} from './pipeline.js';
export { runSimulation, simDefaultScripts, simModelsConfig, simRoutesConfig, simSpecContent } from './pipeline.js';
export type { SimPhaseName, SimTerminalState } from './types.js';
export type { SimWorkspace } from './workspace.js';
export { createSimWorkspace, simCommitAll } from './workspace.js';
