// packages/core/src/testing.ts — Test doubles and contract kits for exercising the
// factory without real model CLIs. See ADR-0004 for the public/internal/testing split.

export type { TempDirs } from './harness/temp-dir.js';
export { createTempDirs, withTempDir } from './harness/temp-dir.js';
export type { HarnessContractCase, HarnessContractScenario, HarnessContractScenarios } from './harness/contract.js';
export { codingHarnessContractCases, makeContractRequest } from './harness/contract.js';
export type { InjectionFixture, InjectionSurface } from './harness/injection-fixtures.js';
export { loadInjectionFixtures } from './harness/injection-fixtures.js';
export type { StubCodingHarnessOptions, StubHarnessStep } from './harness/stub.js';
export { StubCodingHarness } from './harness/stub.js';
export type { SimClock, SimLatency } from './fakes/latency.js';
export { applyLatency, realSimClock, resolveLatencyMs } from './fakes/latency.js';
export type { SimModelCall, SimModelExecutorOptions, SimModelStep } from './testing/sim/model.js';
export { failOnCall, SimModelExecutor } from './testing/sim/model.js';
export type {
  SimOctokit,
  SimOctokitEndpoint,
  SimOctokitOptions,
  SimOctokitStep,
  SimRecordedCall,
} from './fakes/octokit.js';
export { createSimOctokit } from './fakes/octokit.js';
export type { FakeGitHub, FakeGitHubRequest, FakeGitHubRoute } from './fakes/fake-github.js';
export { createFakeGitHub, githubError } from './fakes/fake-github.js';
export type { SimWorkspace } from './testing/sim/workspace.js';
export { createSimWorkspace, simCommitAll } from './testing/sim/workspace.js';
export type { StubModelExecutorOptions } from './router/stub.js';
export { StubModelExecutor } from './router/stub.js';
export { simWorkspace } from './run/ports.js';
export { loadReusablePlan } from './run/plan-reuse-load.js'; // plan-reuse assertions (#4025)
