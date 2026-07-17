// packages/core/src/testing.ts — Test doubles and contract kits for exercising the
// factory without real model CLIs. See ADR-0004 for the public/internal/testing split.

export type { HarnessContractCase, HarnessContractScenario, HarnessContractScenarios } from './harness/contract.js';
export { codingHarnessContractCases, makeContractRequest } from './harness/contract.js';
export type { StubCodingHarnessOptions, StubHarnessStep } from './harness/stub.js';
export { StubCodingHarness } from './harness/stub.js';
export type { StubModelExecutorOptions } from './router/stub.js';
export { StubModelExecutor } from './router/stub.js';
