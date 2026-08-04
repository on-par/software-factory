// packages/core/src/testing.ts — Test doubles and contract kits for exercising the
// factory without real model CLIs. See ADR-0004 for the public/internal/testing split.

export type { HarnessContractCase, HarnessContractScenario, HarnessContractScenarios } from './harness/contract.js';
export { codingHarnessContractCases, makeContractRequest } from './harness/contract.js';
export type { InjectionFixture, InjectionSurface } from './harness/injection-fixtures.js';
export { loadInjectionFixtures } from './harness/injection-fixtures.js';
export type { StubCodingHarnessOptions, StubHarnessStep } from './harness/stub.js';
export { StubCodingHarness } from './harness/stub.js';
export type {
  MonteCarloBreach,
  MonteCarloOptions,
  MonteCarloRates,
  MonteCarloReport,
  MonteCarloRunSummary,
  MonteCarloThresholds,
  SimClock,
  SimFailureMode,
  SimIssueOutcome,
  SimIssueSpec,
  SimJitterConfig,
  SimJitterDraw,
  SimJitterSeam,
  SimLatency,
  SimModelCall,
  SimModelExecutorOptions,
  SimModelStep,
  SimOctokit,
  SimOctokitEndpoint,
  SimOctokitOptions,
  SimOctokitStep,
  SimPhaseJitter,
  SimPhaseName,
  SimPipelineEvent,
  SimRecordedCall,
  SimTerminalState,
  SimulationOptions,
  SimulationReport,
  SimWorkspace,
} from './sim/index.js';
export {
  aggregateMonteCarlo,
  applyLatency,
  createSeededRandom,
  createSimOctokit,
  createSimWorkspace,
  deriveSimSeed,
  failOnCall,
  monteCarloExitCode,
  realSimClock,
  renderMonteCarloTable,
  resolveLatencyMs,
  runMonteCarlo,
  runSimulation,
  SIM_FAILURE_MODES,
  SIM_MALFORMED_OUTPUT,
  simCommitAll,
  simDefaultScripts,
  SimJitter,
  SimJitterExecutor,
  SimModelExecutor,
  simModelsConfig,
  simRoutesConfig,
  simSpecContent,
  summarizeSimulationRun,
  withSimJitter,
} from './sim/index.js';
export type { StubModelExecutorOptions } from './router/stub.js';
export { StubModelExecutor } from './router/stub.js';
