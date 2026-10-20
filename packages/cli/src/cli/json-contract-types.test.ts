import type { QueueListJson, QueueListOrderConflictJson } from './queue-list.js';
import type { buildQueueListJson } from './queue-list.js';
import type { UsageJson, UsageJsonSource } from './usage-json.js';
import type { buildUsageJson } from './usage-json.js';
import type { CostJson, CostModelRowJson, CostRowJson } from './cost-json.js';
import type { buildCostJson } from './cost-json.js';
import type { RunsJson } from './runs.js';
import type { buildRunsJson } from './runs.js';
import type { RunDiffstatJson } from './runs-diffstat.js';
import type { buildRunDiffstatJson } from './runs-diffstat.js';
import type { DaemonStatusJson } from './daemon.js';
import type {
  CostJson as ContractCostJson,
  QueueListJson as ContractQueueListJson,
  RunDiffstatJson as ContractRunDiffstatJson,
  RunsJson as ContractRunsJson,
  UsageJson as ContractUsageJson,
} from './json-contract.js';
import { expect, it } from 'vitest';

type Equal<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;
type QueueBuilderMatches = Equal<ReturnType<typeof buildQueueListJson>, ContractQueueListJson>;
type UsageBuilderMatches = Equal<ReturnType<typeof buildUsageJson>, ContractUsageJson>;
type CostBuilderMatches = Equal<ReturnType<typeof buildCostJson>, ContractCostJson>;
type RunsBuilderMatches = Equal<Awaited<ReturnType<typeof buildRunsJson>>['json'], ContractRunsJson>;
type DiffstatBuilderMatches = Equal<Awaited<ReturnType<typeof buildRunDiffstatJson>>, ContractRunDiffstatJson>;
type QueueConflictAliasMatches = Equal<QueueListOrderConflictJson, QueueListJson['orderConflicts'][number]>;
type UsageSourceAliasMatches = Equal<UsageJsonSource, UsageJson['source']>;
type CostRowAliasMatches = Equal<CostRowJson, CostJson['rows'][number]>;
type CostModelAliasMatches = Equal<CostModelRowJson, CostJson['perModel'][number]>;
type LogsKeysMatch = Equal<keyof FactoryEvent, Exclude<keyof LogsLineJson, 'cursor'>>;
type StatusBuilderMatches = Equal<ReturnType<typeof buildStatusJson>, StatusJson>;
type LogsBuilderMatches = Equal<ReturnType<typeof buildLogsJson>, LogsLineJson>;
type QueueAddBuilderMatches = Equal<ReturnType<typeof buildQueueAddJson>, ContractQueueAddJson>;
type QueueAddIssueAliasMatches = Equal<QueueAddIssueJson, ContractQueueAddIssueJson>;
type StopResumeBuilderMatches = Equal<ReturnType<typeof buildStopResumeJson>, ContractStopResumeJson>;
type UnparkProducerMatches = Equal<Awaited<ReturnType<typeof runUnpark>>, UnparkJson>;

function typeContractChecks(): void {
  const invalidDaemon: DaemonStatusJson = {
    schemaVersion: 1,
    running: false,
    pid: null,
    uptimeSec: null,
    plistInstalled: false,
    repos: [],
    // @ts-expect-error Undeclared daemon status fields must fail excess-property checking.
    unexpected: true,
  };
  const invalidQueue: QueueListJson = {
    schemaVersion: 1,
    lanes: [],
    orderConflicts: [],
    // @ts-expect-error Undeclared queue fields must fail excess-property checking.
    unexpected: true,
  };
  const invalidUsage: UsageJson = {
    schemaVersion: 1,
    source: 'unavailable',
    utilizationPct: null,
    resetsAt: null,
    windowHours: 5,
    estimateUsd: null,
    // @ts-expect-error Undeclared usage fields must fail excess-property checking.
    unexpected: true,
  };
  const invalidCost: CostJson = {
    schemaVersion: 1,
    rows: [],
    perModel: [],
    total: { cost: 0, unpricedCount: 0 },
    // @ts-expect-error Undeclared cost fields must fail excess-property checking.
    unexpected: true,
  };
  const invalidRuns: RunsJson = {
    schemaVersion: 1,
    runs: [],
    // @ts-expect-error Undeclared runs fields must fail excess-property checking.
    unexpected: true,
  };
  const invalidDiffstat: RunDiffstatJson = {
    schemaVersion: 1,
    issue: 1,
    branch: null,
    base: 'main',
    files: null,
    totals: null,
    reason: 'no-branch',
    // @ts-expect-error Undeclared diffstat fields must fail excess-property checking.
    unexpected: true,
  };
  void [invalidDaemon, invalidQueue, invalidUsage, invalidCost, invalidRuns, invalidDiffstat];
}

void typeContractChecks;
const typeChecks: [
  QueueBuilderMatches,
  UsageBuilderMatches,
  CostBuilderMatches,
  RunsBuilderMatches,
  DiffstatBuilderMatches,
  QueueConflictAliasMatches,
  UsageSourceAliasMatches,
  CostRowAliasMatches,
  CostModelAliasMatches,
] = [true, true, true, true, true, true, true, true, true];
void typeChecks;

const additionalTypeChecks: [
  LogsKeysMatch,
  StatusBuilderMatches,
  LogsBuilderMatches,
  QueueAddBuilderMatches,
  QueueAddIssueAliasMatches,
  StopResumeBuilderMatches,
  UnparkProducerMatches,
] = [true, true, true, true, true, true, true];
void additionalTypeChecks;

it('keeps JSON builder types aligned with their contracts', () => {
  expect([...typeChecks, ...additionalTypeChecks].every(Boolean)).toBe(true);
});
import type { FactoryEvent } from '@on-par/factory-core';
import type { QueueAddIssueJson, buildQueueAddJson } from './queue-add-json.js';
import type { buildStopResumeJson } from './stop-resume-json.js';
import type { runUnpark } from './unpark.js';
import type {
  LogsLineJson,
  QueueAddIssueJson as ContractQueueAddIssueJson,
  QueueAddJson as ContractQueueAddJson,
  StatusJson,
  StopResumeJson as ContractStopResumeJson,
  UnparkJson,
} from './json-contract.js';
import type { buildLogsJson } from './logs.js';
import type { buildStatusJson } from './status-json.js';
