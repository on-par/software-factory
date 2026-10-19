import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FactoryEvent } from '@on-par/factory-core';
import { createLogger } from '@on-par/factory-core';
import { buildLogsJson, runLogs } from './logs.js';
import { buildStatusJson } from './status-json.js';
import { logsLineJsonSchema, statusJsonSchema, type LogsLineJson, type StatusJson } from './json-contract.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixedNow = Date.parse('2026-01-01T00:10:00.000Z');
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
  now: fixedNow,
};

const statusGolden = JSON.parse(
  readFileSync(new URL('./__fixtures__/json/status.json', import.meta.url), 'utf-8'),
) as unknown;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('JSON wire contracts', () => {
  it('matches the status golden and validates it', () => {
    const output = buildStatusJson(statusInput);
    expect(output).toEqual(statusGolden);
    expect(statusJsonSchema.parse(output)).toEqual(output);
    expect(statusJsonSchema.parse(statusGolden)).toEqual(statusGolden);
  });

  it('rejects a string breaker', () => {
    expect(statusJsonSchema.safeParse({ ...(statusGolden as object), breaker: 'openai' }).success).toBe(false);
    expect(statusJsonSchema.safeParse({ ...(statusGolden as object), schemaVersion: 2 }).success).toBe(false);
  });

  it('matches a real cursor-bearing logs line to the golden and validates it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'factory-json-contract-'));
    const eventsFile = join(directory, 'events.ndjson');
    vi.setSystemTime(new Date('2026-01-01T00:10:00.000Z'));
    try {
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
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
});

type Equal<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;
type LogsKeysMatch = Equal<keyof FactoryEvent, Exclude<keyof LogsLineJson, 'cursor'>>;
type StatusBuilderMatches = Equal<ReturnType<typeof buildStatusJson>, StatusJson>;
type LogsBuilderMatches = Equal<ReturnType<typeof buildLogsJson>, LogsLineJson>;

function typeContractChecks(): void {
  const validStatus: StatusJson = {
    schemaVersion: 1,
    repo: 'r',
    product: null,
    stop: false,
    stopInfo: null,
    breaker: { open: false, providers: [] },
    active: [],
    update: null,
  };
  function invalidStatus(): StatusJson {
    const value: StatusJson = {
      schemaVersion: 1,
      repo: 'r',
      product: null,
      stop: false,
      stopInfo: null,
      breaker: { open: false, providers: [] },
      active: [],
      update: null,
      // @ts-expect-error Undeclared status wire fields must fail excess-property checking.
      unexpected: true,
    };
    return value;
  }
  function invalidLogs(): LogsLineJson {
    const value: LogsLineJson = {
      ts: '',
      type: 'plan',
      issue: '',
      msg: '',
      // @ts-expect-error Undeclared log envelope fields must fail excess-property checking.
      unexpected: true,
    };
    return value;
  }
  void [validStatus, invalidStatus, invalidLogs];
}

void typeContractChecks;
const typeChecks: [LogsKeysMatch, StatusBuilderMatches, LogsBuilderMatches] = [true, true, true];
void typeChecks;
