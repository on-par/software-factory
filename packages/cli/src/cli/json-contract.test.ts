import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { FactoryEvent } from '@on-par/factory-core';
import { createLogger, loadFactoryConfig } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import type { QueueSnapshot } from '@on-par/factory-core/internal';
import type { EnqueueResult } from '@on-par/factory-core/internal';
import { unparkClient } from './test-support/unpark-client.js';
import { cmdDaemonStatus } from './daemon.js';
import { buildQueueListJson } from './queue-list.js';
import { buildUsageJson } from './usage-json.js';
import { buildCostJson } from './cost-json.js';
import { buildRunsJson } from './runs.js';
import { buildRunDiffstatJson } from './runs-diffstat.js';
import { buildQueueAddJson } from './queue-add-json.js';
import { buildStopResumeJson } from './stop-resume-json.js';
import { runUnpark } from './unpark.js';
import { buildLogsJson, runLogs } from './logs.js';
import { buildStatusJson } from './status-json.js';
import {
  checkJsonSchema,
  draftJsonSchema,
  costJsonSchema,
  daemonStatusJsonSchema,
  kpisJsonSchema,
  logsLineJsonSchema,
  queueListJsonSchema,
  queueAddJsonSchema,
  resumeJsonSchema,
  runDiffstatJsonSchema,
  runsJsonSchema,
  statusJsonSchema,
  stopJsonSchema,
  unparkJsonSchema,
  usageJsonSchema,
} from './json-contract.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { format, resolveConfig } from 'prettier';
import { z } from 'zod';

const fixedNow = Date.parse('2026-01-01T00:10:00.000Z');
const tempDirs = createTempDirs();
const statusInput = {
  repo: 'acme/widgets',
  product: 'widget-service',
  stop: true,
  stopInfo: { source: 'usage-watchdog' as const, setAt: '2026-01-01T00:09:00.000Z' },
  breakers: [{ provider: 'openai', reason: 'usage_cap', openedAt: '2026-01-01T00:08:29.500Z', remainingMs: 90_500 }],
  active: [
    { lane: 'app', issue: 3175, phase: 'build' as const, lastActivityAt: new Date(fixedNow - 125_000).toISOString() },
  ],
  update: {
    mode: 'stable' as const,
    channel: 'latest' as const,
    installKind: 'npm-global' as const,
    current: '0.9.4',
    available: '0.9.5',
    lastCheckAt: '2026-01-01T00:00:00.000Z',
    lastResult: {
      at: '2025-12-31T23:55:00.000Z',
      version: '0.9.3',
      outcome: 'failed' as const,
      error: 'network unavailable',
    },
    draining: { since: '2026-01-01T00:05:00.000Z', target: '0.9.5', stopFiles: ['/tmp/lane-a/STOP'] },
  },
  openFactoryDrafts: { count: 3, oldestHours: 30 },
  disk: { freeGb: 42.5, thresholdGb: 10, low: false },
  now: fixedNow,
};

const statusGolden = JSON.parse(
  readFileSync(new URL('./__fixtures__/json/status.json', import.meta.url), 'utf-8'),
) as unknown;
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/json/${name}`, import.meta.url), 'utf-8')) as unknown;
const generatedContracts = [
  ['status.schema.json', 'status.json', statusJsonSchema],
  ['kpis.schema.json', 'kpis.json', kpisJsonSchema],
  ['logs-line.schema.json', 'logs-line.json', logsLineJsonSchema],
  ['daemon-status.schema.json', 'daemon-status.json', daemonStatusJsonSchema],
  ['queue-list.schema.json', 'queue-list.json', queueListJsonSchema],
  ['usage.schema.json', 'usage.json', usageJsonSchema],
  ['cost.schema.json', 'cost.json', costJsonSchema],
  ['runs.schema.json', 'runs.json', runsJsonSchema],
  ['runs-diffstat.schema.json', 'runs-diffstat.json', runDiffstatJsonSchema],
  ['queue-add.schema.json', '../queue-add.json', queueAddJsonSchema],
  ['stop.schema.json', 'stop.json', stopJsonSchema],
  ['resume.schema.json', 'resume.json', resumeJsonSchema],
  ['unpark.schema.json', 'unpark.json', unparkJsonSchema],
  ['check.schema.json', 'check.json', checkJsonSchema],
  ['draft.schema.json', 'draft.json', draftJsonSchema],
] as const;

const queueLabels = (position: number): string[] => ['factory:queued', 'factory:lane:ops', `factory:order:${position}`];
const fixedQueueAddResults: EnqueueResult[] = [
  { issue: 1, outcome: 'queued', position: 3, labelsAdded: queueLabels(3), labelsCreated: ['factory:order:3'] },
  { issue: 2, outcome: 'queued', position: 4, labelsAdded: queueLabels(4), labelsCreated: ['factory:order:4'] },
  { issue: 3, outcome: 'already-queued', position: 1, labelsAdded: [], labelsCreated: [] },
];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await tempDirs.cleanup();
});

describe('JSON wire contracts', () => {
  it('validates every golden fixture against its committed generated schema', async () => {
    const ajv = new Ajv2020();
    const formatOptions = (await resolveConfig(new URL(import.meta.url).pathname)) ?? {};
    for (const [schemaFilename, fixtureFilename, zodSchema] of generatedContracts) {
      const schemaText = readFileSync(new URL(`../../schemas/${schemaFilename}`, import.meta.url), 'utf-8');
      expect(schemaText).toBe(
        await format(JSON.stringify(z.toJSONSchema(zodSchema), null, 2), { ...formatOptions, parser: 'json' }),
      );
      const validator = ajv.compile(JSON.parse(schemaText) as object);
      const valid = validator(fixture(fixtureFilename));
      expect(valid, `${schemaFilename} errors: ${JSON.stringify(validator.errors)}`).toBe(true);
    }
  });

  it('generated status schema requires the breaker object', () => {
    const schema = JSON.parse(readFileSync(new URL('../../schemas/status.schema.json', import.meta.url), 'utf-8')) as {
      properties: { breaker: { type: string; required: string[] }; schemaVersion: { const: number } };
    };
    expect(schema.properties.breaker.type).toBe('object');
    expect(schema.properties.breaker.required).toEqual(expect.arrayContaining(['open', 'providers']));
    expect(schema.properties.schemaVersion.const).toBe(1);
    const validator = new Ajv2020().compile(schema);
    const status = fixture('status.json') as Record<string, unknown>;
    expect(validator({ ...status, breaker: 'openai' })).toBe(false);
    const breaker = status.breaker as Record<string, unknown>;
    expect(validator({ ...status, breaker: { providers: breaker.providers } })).toBe(false);
    expect(validator({ ...status, breaker: { open: breaker.open } })).toBe(false);
  });

  it('keeps logs as an unversioned line with arbitrary object payloads', () => {
    const schema = JSON.parse(
      readFileSync(new URL('../../schemas/logs-line.schema.json', import.meta.url), 'utf-8'),
    ) as object;
    const validator = new Ajv2020().compile(schema);
    const logsFixture = fixture('logs-line.json') as Record<string, unknown>;
    expect(logsFixture).not.toHaveProperty('schemaVersion');
    expect(validator({ ...logsFixture, rework: { nested: { custom: ['value'] } } })).toBe(true);
  });

  it('matches the status golden and validates it', () => {
    const output = buildStatusJson(statusInput);
    expect(output).toEqual(statusGolden);
    expect(statusJsonSchema.parse(output)).toEqual(output);
    expect(statusJsonSchema.parse(statusGolden)).toEqual(statusGolden);
  });

  it('matches the queue-add golden and validates it', () => {
    const output = buildQueueAddJson('ops', fixedQueueAddResults);
    const golden = fixture('../queue-add.json');
    expect(output).toEqual(golden);
    expect(queueAddJsonSchema.parse(output)).toEqual(output);
    expect(queueAddJsonSchema.parse(golden)).toEqual(golden);
  });

  it('matches the stop golden and validates it', () => {
    const output = buildStopResumeJson({ action: 'stop', repo: 'on-par/example', before: false, after: true });
    const golden = fixture('stop.json');
    expect(output).toEqual(golden);
    expect(stopJsonSchema.parse(output)).toEqual(output);
    expect(stopJsonSchema.parse(golden)).toEqual(golden);
  });

  it('matches the resume golden and validates it', () => {
    const output = buildStopResumeJson({ action: 'resume', repo: 'on-par/example', before: true, after: false });
    const golden = fixture('resume.json');
    expect(output).toEqual(golden);
    expect(resumeJsonSchema.parse(output)).toEqual(output);
    expect(resumeJsonSchema.parse(golden)).toEqual(golden);
  });

  it('matches the unpark golden from the real producer and validates it', async () => {
    const labels = new Map<number, string[]>([
      [1, ['factory:queued', 'factory:lane:ops', 'factory:order:1']],
      [2, ['factory:queued', 'factory:lane:ops', 'factory:order:2']],
      [42, ['bug', 'factory:parked', 'factory:lane:ops']],
    ]);
    const output = await runUnpark({ owner: 'on-par', repo: 'example', issue: 42, client: unparkClient(labels) });
    const golden = fixture('unpark.json');
    expect(output).toEqual(golden);
    expect(unparkJsonSchema.parse(output)).toEqual(output);
    expect(unparkJsonSchema.parse(golden)).toEqual(golden);
  });

  it('preserves optional unpark collision fields in the generated schema', async () => {
    const labels = new Map<number, string[]>([
      [23, ['factory:queued', 'factory:lane:ops', 'factory:order:23']],
      [24, ['factory:lane:ops', 'factory:order:24']],
      [42, ['bug', 'factory:parked', 'factory:lane:ops']],
    ]);
    const output = await runUnpark({ owner: 'on-par', repo: 'example', issue: 42, client: unparkClient(labels) });
    expect(output.collision).toEqual({ order: 24, heldBy: [24] });
    expect(unparkJsonSchema.parse(output)).toEqual(output);
    const schema = JSON.parse(
      readFileSync(new URL('../../schemas/unpark.schema.json', import.meta.url), 'utf-8'),
    ) as object;
    expect(new Ajv2020().compile(schema)(output)).toBe(true);
    const withoutCollision = { ...output };
    delete (withoutCollision as { collision?: unknown }).collision;
    expect(unparkJsonSchema.parse(withoutCollision)).toEqual(withoutCollision);
  });

  it('rejects invalid write-action envelopes and action literals', () => {
    const queue = fixture('../queue-add.json') as Record<string, unknown>;
    const stop = fixture('stop.json') as Record<string, unknown>;
    const resume = fixture('resume.json') as Record<string, unknown>;
    const unpark = fixture('unpark.json') as Record<string, unknown>;
    const rejected = [
      queueAddJsonSchema.safeParse({ schemaVersion: 1 }),
      queueAddJsonSchema.safeParse({ ...queue, issues: 'none' }),
      queueAddJsonSchema.safeParse({ ...queue, schemaVersion: 2 }),
      queueAddJsonSchema.safeParse({
        ...queue,
        issues: [{ number: 1, outcome: 'other', order: 1, labelsAdded: [] }],
      }),
      queueAddJsonSchema.safeParse({ ...queue, action: 'other' }),
      queueAddJsonSchema.safeParse({ ...queue, ok: 'yes' }),
      stopJsonSchema.safeParse({ ...stop, action: 'resume' }),
      resumeJsonSchema.safeParse({ ...resume, action: 'stop' }),
      resumeJsonSchema.safeParse({ ...resume, repo: 42 }),
      unparkJsonSchema.safeParse({ ...unpark, labelsAfter: 'queued' }),
      unparkJsonSchema.safeParse({ ...unpark, schemaVersion: 2 }),
      unparkJsonSchema.safeParse({ ...unpark, action: 'queue-add' }),
    ];
    expect(rejected.every(({ success }) => !success)).toBe(true);
  });

  it('rejects a string breaker', () => {
    expect(statusJsonSchema.safeParse({ ...(statusGolden as object), breaker: 'openai' }).success).toBe(false);
    expect(statusJsonSchema.safeParse({ ...(statusGolden as object), schemaVersion: 2 }).success).toBe(false);
  });

  it('matches a real cursor-bearing logs line to the golden and validates it', async () => {
    const directory = tempDirs.makeSync('factory-json-contract-');
    const eventsFile = join(directory, 'events.ndjson');
    vi.setSystemTime(new Date('2026-01-01T00:10:00.000Z'));
    const logger = createLogger(
      eventsFile,
      { repo: 'acme/widgets', lane: 'app', phase: 'build', issue: 3175 },
      {
        out: { write: () => {} },
        env: {},
      },
    );
    logger.info('plan', 'Started contract fixture event', {
      model: 'gpt-6.1-sol',
      tokens: { input: 42, output: 17 },
      durationMs: 1250,
      rework: { round: 1, failingChecks: ['tests'], cause: 'factory-fault' },
    });
    const emitted: string[] = [];
    runLogs(eventsFile, { json: true, limit: 1 }, { out: { write: (line) => emitted.push(line) }, env: {} });
    expect(emitted).toHaveLength(1);
    const parsed: unknown = JSON.parse(emitted[0] ?? '');
    const golden = JSON.parse(
      readFileSync(new URL('./__fixtures__/json/logs-line.json', import.meta.url), 'utf-8'),
    ) as unknown;
    expect(parsed).toEqual(golden);
    expect(logsLineJsonSchema.parse(parsed)).toEqual(parsed);
    expect(logsLineJsonSchema.parse(golden)).toEqual(golden);
  });

  it('accepts legacy lines without cursor or optional fields', () => {
    const legacy = { ts: 'not-a-date', type: 'future-event', issue: '1', msg: 'legacy' };
    expect(logsLineJsonSchema.parse(legacy)).toEqual(legacy);
    expect(logsLineJsonSchema.safeParse({ ...legacy, cursor: undefined }).success).toBe(true);
  });

  it('requires envelope fields and validates scalar field types', () => {
    const line = { ts: 'now', type: 'future-event', issue: '1', msg: 'hello' };
    expect(logsLineJsonSchema.safeParse({ ts: line.ts, type: line.type, issue: line.issue }).success).toBe(false);
    expect(logsLineJsonSchema.safeParse({ ...line, durationMs: '1250' }).success).toBe(false);
    expect(logsLineJsonSchema.safeParse({ ...line, tokens: { input: '42', output: 17 } }).success).toBe(false);
  });

  it('preserves arbitrary nested payload keys and rejects non-object payloads', () => {
    const payload = { custom: { nested: ['kept'] } };
    const line = { ts: 'now', type: 'future-event', issue: '1', msg: 'hello', rework: payload };
    expect(logsLineJsonSchema.parse(line)).toEqual(line);
    for (const rework of [null, [], 'scalar', 4, true]) {
      expect(logsLineJsonSchema.safeParse({ ...line, rework }).success).toBe(false);
    }
  });

  it('builds logs envelopes with optional cursor only when supplied', () => {
    const event: FactoryEvent = {
      ts: 'now',
      type: 'plan',
      issue: '1',
      msg: 'hello',
      rework: { round: 1, failingChecks: ['tests'], cause: 'external' },
    };
    expect(buildLogsJson(event)).toEqual(event);
    expect(buildLogsJson(event, { cursor: 'segment:offset' })).toEqual({ ...event, cursor: 'segment:offset' });
  });

  it('matches the daemon status golden and validates the captured command output', async () => {
    const home = tempDirs.makeSync('factory-json-daemon-');
    const registryFile = join(home, '.factory', 'registry.json');
    mkdirSync(join(home, '.factory'), { recursive: true });
    writeFileSync(
      registryFile,
      JSON.stringify({
        version: 1,
        repos: {
          'acme/api': { path: '/checkouts/api', attachedAt: '2026-01-01T00:00:00.000Z', state: 'active' },
          'acme/web': { path: '/checkouts/web', attachedAt: '2026-01-01T00:00:00.000Z', state: 'paused' },
        },
      }),
    );
    const output: string[] = [];
    await cmdDaemonStatus(
      {
        platform: 'darwin',
        uid: 501,
        home,
        registryFile,
        loadConfig: () => loadFactoryConfig(),
        out: { write: (line) => output.push(line) },
        exec: async (cmd) =>
          cmd === 'launchctl'
            ? { code: 0, stdout: 'pid = 42', stderr: '' }
            : { code: 0, stdout: '00:02:03', stderr: '' },
      },
      { json: true },
    );
    const parsed: unknown = JSON.parse(output[0] ?? '');
    const golden = fixture('daemon-status.json');
    expect(parsed).toEqual(golden);
    expect(daemonStatusJsonSchema.parse(parsed)).toEqual(parsed);
    expect(daemonStatusJsonSchema.parse(golden)).toEqual(golden);
  });

  it('matches the queue list golden and validates its conflict forms', () => {
    const snapshot = {
      entries: [
        { issue: 31, lane: 'api', title: 'Ship API', status: 'in-progress', claimant: 'worker-a' },
        { issue: 32, lane: 'api', title: 'Add tests' },
        { issue: 40, lane: 'web', status: 'parked' },
      ],
      orderConflicts: [
        { lane: 'api', position: 1, issues: [31, 32] },
        { lane: 'web', position: null, issues: [41], reason: 'missing-order-label' },
      ],
    } as QueueSnapshot;
    const output = buildQueueListJson(snapshot);
    const golden = fixture('queue-list.json');
    expect(output).toEqual(golden);
    expect(queueListJsonSchema.parse(output)).toEqual(output);
    expect(queueListJsonSchema.parse(golden)).toEqual(golden);
  });

  it('matches the usage golden and validates its unrounded subscription reading', () => {
    const output = buildUsageJson(
      { fiveHourUtilization: 47.25, fiveHourResetsAt: '2026-01-01T05:00:00.000Z' },
      12.345,
      100,
      'subscription',
    );
    const golden = fixture('usage.json');
    expect(output).toEqual(golden);
    expect(usageJsonSchema.parse(output)).toEqual(output);
    expect(usageJsonSchema.parse(golden)).toEqual(golden);
  });

  it('matches the cost golden and validates priced and unpriced rows', () => {
    const output = buildCostJson([
      {
        ts: '2026-01-01T00:00:00.000Z',
        issue: '31',
        task: 'build',
        model: 'model-a',
        inputTokens: 120,
        outputTokens: 20,
        cacheReadTokens: 12,
        cacheCreationTokens: 3,
        cost: 1.2345,
      },
      {
        ts: '2026-01-01T00:01:00.000Z',
        issue: '32',
        task: 'check',
        model: 'model-b',
        inputTokens: 80,
        outputTokens: 10,
        cost: null,
        unpriced: true,
      },
    ]);
    const golden = fixture('cost.json');
    expect(output).toEqual(golden);
    expect(costJsonSchema.parse(output)).toEqual(output);
    expect(costJsonSchema.parse(golden)).toEqual(golden);
  });

  it('matches the runs golden and validates merged and phase-only rows', async () => {
    const directory = tempDirs.makeSync('factory-json-runs-');
    writeFileSync(
      join(directory, 'issue-31.json'),
      JSON.stringify({
        issue: 31,
        lane: 'api',
        repo: 'acme/api',
        status: 'running',
        branch: 'factory/31',
        prNumber: 98,
        model: 'model-a',
        attempts: 2,
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:05:00.000Z',
      }),
    );
    writeFileSync(
      join(directory, 'issue-31.phase.json'),
      JSON.stringify({
        issue: 31,
        phase: 'check',
        updatedAt: '2026-01-01T00:06:00.000Z',
        lastActivityAt: '2026-01-01T00:06:00.000Z',
      }),
    );
    writeFileSync(
      join(directory, 'issue-32.phase.json'),
      JSON.stringify({
        issue: 32,
        phase: 'plan',
        updatedAt: '2026-01-01T00:04:00.000Z',
        lastActivityAt: '2026-01-01T00:04:00.000Z',
      }),
    );
    const { json } = await buildRunsJson(directory);
    const golden = fixture('runs.json');
    expect(json).toEqual(golden);
    expect(runsJsonSchema.parse(json)).toEqual(json);
    expect(runsJsonSchema.parse(golden)).toEqual(golden);
  });

  it('matches the diffstat golden and validates text and binary file counts', async () => {
    const directory = tempDirs.makeSync('factory-json-diffstat-');
    const runsDir = join(directory, 'runs');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(runsDir, 'issue-31.json'),
      JSON.stringify({ issue: 31, branch: 'factory/31', updatedAt: '2026-01-01T00:00:00.000Z' }),
    );
    const output = await buildRunDiffstatJson({
      runsDir,
      repoRoot: '/checkouts/repo',
      issue: 31,
      resolveBase: async () => 'origin/main',
      git: async (args) => (args[0] === 'diff' ? '2\t1\tREADME.md\0-\t-\timage.png\0' : 'resolved'),
    });
    const golden = fixture('runs-diffstat.json');
    expect(output).toEqual(golden);
    expect(runDiffstatJsonSchema.parse(output)).toEqual(output);
    expect(runDiffstatJsonSchema.parse(golden)).toEqual(golden);
  });

  it('rejects missing fields, wrong scalar types, and schemaVersion 2 for new contracts', () => {
    const invalid = [
      [daemonStatusJsonSchema, { schemaVersion: 1 }],
      [queueListJsonSchema, { schemaVersion: 1, lanes: [], orderConflicts: 'none' }],
      [
        usageJsonSchema,
        {
          schemaVersion: 1,
          source: 'unavailable',
          utilizationPct: null,
          resetsAt: null,
          windowHours: '5',
          estimateUsd: null,
        },
      ],
      [costJsonSchema, { schemaVersion: 1, rows: 'none', perModel: [], total: { cost: 0, unpricedCount: 0 } }],
      [runsJsonSchema, { schemaVersion: 2, runs: [] }],
      [runDiffstatJsonSchema, { schemaVersion: 1, issue: 1, branch: null, base: 'main', files: null, totals: null }],
    ] as const;
    for (const [schema, value] of invalid) expect(schema.safeParse(value).success).toBe(false);
  });
});
