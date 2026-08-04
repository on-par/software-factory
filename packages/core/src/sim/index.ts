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
export type {
  MonteCarloBreach,
  MonteCarloOptions,
  MonteCarloRates,
  MonteCarloReport,
  MonteCarloRunSummary,
  MonteCarloThresholds,
} from './monte-carlo.js';
export {
  aggregateMonteCarlo,
  monteCarloExitCode,
  renderMonteCarloTable,
  runMonteCarlo,
  summarizeSimulationRun,
} from './monte-carlo.js';
export type { MonteCarloCliArgs, MonteCarloCliDeps, MonteCarloFormat } from './monte-carlo-cli.js';
export {
  MONTE_CARLO_CLI_USAGE,
  parseMonteCarloArgs,
  runMonteCarloCli,
  simMonteCarloIssues,
} from './monte-carlo-cli.js';
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
export type { SimRegressionFixture } from './regressions.js';
export {
  SIM_FENCED_ENRICHMENT_OUTPUT,
  SIM_REGRESSION_FIXTURES,
  simRegressionFixture,
  simSpecWithObjectInterface,
} from './regressions.js';
export type { SimPhaseName, SimTerminalState } from './types.js';
export type { SimWorkspace } from './workspace.js';
export { createSimWorkspace, simCommitAll } from './workspace.js';
