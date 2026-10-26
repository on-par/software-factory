import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readCosts } from '@on-par/factory-core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCostJson, filterCostEntries, parseCostFilter } from './cost-json.js';
import { costJsonSchema } from './json-contract.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'factory-cost-json-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const load = (rows: Array<Record<string, unknown>>) => {
  const file = join(dir, 'costs.jsonl');
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
  return readCosts(file);
};
const row = (extra: Record<string, unknown>) => ({
  ts: '2026-01-01T00:00:00Z',
  issue: '1',
  task: 'build',
  model: 'a',
  inputTokens: 10,
  outputTokens: 5,
  ...extra,
});

describe('buildCostJson', () => {
  it('rolls up priced rows', () => {
    const json = buildCostJson(
      load([
        row({ cost: 1, cacheReadTokens: 3, cacheCreationTokens: 4 }),
        row({ cost: 0.5 }),
        row({ model: 'b', cost: 2 }),
      ]),
    );
    expect(costJsonSchema.parse(json)).toEqual(json);
    expect(json.total).toEqual({
      cost: 3.5,
      unpricedCount: 0,
      cachedRateMissingCount: 0,
      tokens: { input: 30, output: 15, rawInput: 0, cacheRead: 3, cacheCreation: 4 },
    });
    expect(json.perModel[0]).toMatchObject({ model: 'a', tasks: 2, cost: 1.5, cachedRateMissingCount: 0 });
    expect(json.rows[0]).toEqual({
      ...row({}),
      rawInputTokens: null,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
      cost: 1,
    });
  });

  it('emits null for unpriced rows and counts them', () => {
    const json = buildCostJson(
      load([
        row({ cost: 2 }),
        row({ cost: null, unpriced: true }),
        row({ model: 'u', cost: null, unpriced: true }),
        row({ model: 'v', cost: 9, unpriced: true }),
        row({ model: 'w' }),
      ]),
    );
    expect(costJsonSchema.parse(json)).toEqual(json);
    expect(json.rows.map((r) => r.cost)).toEqual([2, null, null, null, null]);
    expect(json.total).toEqual({
      cost: 2,
      unpricedCount: 4,
      cachedRateMissingCount: 0,
      tokens: { input: 50, output: 25, rawInput: 0, cacheRead: 0, cacheCreation: 0 },
    });
    expect(json.perModel.find((m) => m.model === 'u')).toMatchObject({
      cost: null,
      unpricedCount: 1,
      cachedRateMissingCount: 0,
    });
    expect(json.perModel.find((m) => m.model === 'a')).toMatchObject({
      cost: 2,
      unpricedCount: 1,
      cachedRateMissingCount: 0,
    });
  });

  it('gives null total when everything is unpriced', () => {
    const json = buildCostJson(load([row({ cost: null, unpriced: true })]));
    expect(json.total).toEqual({
      cost: null,
      unpricedCount: 1,
      cachedRateMissingCount: 0,
      tokens: { input: 10, output: 5, rawInput: 0, cacheRead: 0, cacheCreation: 0 },
    });
  });

  it('filters by issue', () => {
    const entries = load([row({ cost: 1 }), row({ issue: '2', model: 'b', cost: 4 })]);
    const json = buildCostJson(entries, { issue: '2' });
    expect(json.rows).toHaveLength(1);
    expect(json.perModel.map((m) => m.model)).toEqual(['b']);
    expect(json.total).toEqual({
      cost: 4,
      unpricedCount: 0,
      cachedRateMissingCount: 0,
      tokens: { input: 10, output: 5, rawInput: 0, cacheRead: 0, cacheCreation: 0 },
    });
    const none = buildCostJson(entries, { issue: '99' });
    expect(none).toEqual({
      schemaVersion: 1,
      rows: [],
      perModel: [],
      total: {
        cost: 0,
        unpricedCount: 0,
        cachedRateMissingCount: 0,
        tokens: { input: 0, output: 0, rawInput: 0, cacheRead: 0, cacheCreation: 0 },
      },
    });
  });

  it('handles empty and missing files', () => {
    const empty = {
      schemaVersion: 1,
      rows: [],
      perModel: [],
      total: {
        cost: 0,
        unpricedCount: 0,
        cachedRateMissingCount: 0,
        tokens: { input: 0, output: 0, rawInput: 0, cacheRead: 0, cacheCreation: 0 },
      },
    };
    expect(buildCostJson(load([]))).toEqual(empty);
    expect(buildCostJson(readCosts(join(dir, 'missing.jsonl')))).toEqual(empty);
  });

  it('perModel and total carry cache token sums', () => {
    const json = buildCostJson(
      load([
        row({
          model: 'claude',
          inputTokens: 1000,
          outputTokens: 50,
          rawInputTokens: 100,
          cacheReadTokens: 800,
          cacheCreationTokens: 100,
          cost: 1,
        }),
        row({
          model: 'codex',
          inputTokens: 500,
          outputTokens: 20,
          rawInputTokens: 200,
          cacheReadTokens: 300,
          cost: 1,
        }),
      ]),
    );
    expect(costJsonSchema.parse(json)).toEqual(json);
    expect(json.perModel.find((m) => m.model === 'claude')).toMatchObject({
      rawInputTokens: 100,
      cacheReadTokens: 800,
      cacheCreationTokens: 100,
    });
    expect(json.perModel.find((m) => m.model === 'codex')).toMatchObject({
      rawInputTokens: 200,
      cacheReadTokens: 300,
      cacheCreationTokens: 0,
    });
    expect(json.total.tokens).toEqual({ input: 1500, output: 70, rawInput: 300, cacheRead: 1100, cacheCreation: 100 });
    expect(json.rows[0]?.rawInputTokens).toBe(100);
    expect(json.rows[1]?.cacheCreationTokens).toBeNull();
  });

  it('Claude-only total.tokens input equals rawInput + cacheRead + cacheCreation', () => {
    const json = buildCostJson(
      load([
        row({ inputTokens: 1000, rawInputTokens: 100, cacheReadTokens: 800, cacheCreationTokens: 100, cost: 1 }),
        row({ inputTokens: 600, rawInputTokens: 50, cacheReadTokens: 500, cacheCreationTokens: 50, cost: 1 }),
      ]),
    );
    const { input, rawInput, cacheRead, cacheCreation } = json.total.tokens;
    expect(input).toBe(1600);
    expect(input).toBe(rawInput + cacheRead + cacheCreation);
  });

  it('a row without a cache split counts toward input only', () => {
    const json = buildCostJson(load([row({ inputTokens: 400, cost: 1 })]));
    expect(json.rows[0]?.rawInputTokens).toBeNull();
    expect(json.total.tokens).toEqual({ input: 400, output: 5, rawInput: 0, cacheRead: 0, cacheCreation: 0 });
    expect(json.perModel[0]).toMatchObject({ rawInputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
    const mixed = buildCostJson(
      load([
        row({ inputTokens: 400, cost: 1 }),
        row({ inputTokens: 1000, rawInputTokens: 100, cacheReadTokens: 800, cacheCreationTokens: 100, cost: 1 }),
      ]),
    ).total.tokens;
    expect(mixed.input).toBeGreaterThan(mixed.rawInput + mixed.cacheRead + mixed.cacheCreation);
  });

  it('issue filter scopes cache token sums and keeps existing fields', () => {
    const entries = load([
      row({
        issue: '7',
        inputTokens: 1000,
        rawInputTokens: 100,
        cacheReadTokens: 800,
        cacheCreationTokens: 100,
        cost: 1,
      }),
      row({ issue: '7', inputTokens: 600, rawInputTokens: 50, cacheReadTokens: 500, cacheCreationTokens: 50, cost: 2 }),
      row({ issue: '8', inputTokens: 90, rawInputTokens: 9, cacheReadTokens: 80, cacheCreationTokens: 1, cost: 4 }),
    ]);
    const json = buildCostJson(entries, { issue: '7' });
    expect(json.perModel).toEqual([
      {
        model: 'a',
        tasks: 2,
        inputTokens: 1600,
        outputTokens: 10,
        rawInputTokens: 150,
        cacheReadTokens: 1300,
        cacheCreationTokens: 150,
        cost: 3,
        unpricedCount: 0,
        cachedRateMissingCount: 0,
      },
    ]);
    expect(json.total).toEqual({
      cost: 3,
      unpricedCount: 0,
      cachedRateMissingCount: 0,
      tokens: { input: 1600, output: 10, rawInput: 150, cacheRead: 1300, cacheCreation: 150 },
    });
  });

  it('nulls missing cache fields', () => {
    const [r] = buildCostJson(load([row({ cost: 1 })])).rows;
    expect(r?.cacheReadTokens).toBeNull();
    expect(r?.cacheCreationTokens).toBeNull();
  });

  it('reports cachedRateMissingCount per model and in total (#3284)', () => {
    const json = buildCostJson(
      load([
        row({ cost: 1, cachedRateMissing: true }),
        row({ cost: 1, cachedRateMissing: true }),
        row({ cost: 1 }),
        row({ model: 'b', cost: 2 }),
      ]),
    );
    expect(costJsonSchema.parse(json)).toEqual(json);
    expect(json.perModel.find((m) => m.model === 'a')?.cachedRateMissingCount).toBe(2);
    expect(json.perModel.find((m) => m.model === 'b')?.cachedRateMissingCount).toBe(0);
    expect(json.total.cachedRateMissingCount).toBe(2);
  });

  it('since drops older entries from rows, perModel and total (#3187)', () => {
    const entries = load([
      row({ ts: '2026-10-01T00:00:00Z', model: 'old', cost: 100 }),
      row({ ts: '2026-10-10T00:00:00Z', model: 'b', cost: 2 }),
      row({ ts: '2026-10-17T00:00:00Z', model: 'c', cost: 3 }),
    ]);
    const json = buildCostJson(entries, { since: Date.parse('2026-10-10T00:00:00Z') });
    expect(json.rows.map((r) => r.model)).toEqual(['b', 'c']);
    expect(json.perModel.map((m) => m.model)).toEqual(['b', 'c']);
    expect(json.total.cost).toBe(5);
    expect(json.total.tokens.input).toBe(20);
    expect(json.total.tokens.output).toBe(10);
    expect(costJsonSchema.safeParse(json).success).toBe(true);
  });

  it('since drops entries with unparsable ts (#3187)', () => {
    const entries = load([row({ ts: 'garbage', cost: 1 }), row({ ts: '2026-10-17T00:00:00Z', cost: 2 })]);
    const json = buildCostJson(entries, { since: Date.parse('2026-10-10T00:00:00Z') });
    expect(json.rows).toHaveLength(1);
    expect(json.total.cost).toBe(2);
  });

  it('limit caps only rows to the newest N, oldest first (#3187)', () => {
    const entries = load(
      Array.from({ length: 50 }, (_, i) =>
        row({ ts: `2026-10-01T00:00:${String(i).padStart(2, '0')}Z`, task: `t${i + 1}`, cost: 1 }),
      ),
    );
    const json = buildCostJson(entries, { limit: 5 });
    expect(json.rows.map((r) => r.task)).toEqual(['t46', 't47', 't48', 't49', 't50']);
    expect(json.total.cost).toBe(50);
    expect(json.perModel[0]?.tasks).toBe(50);
    const none = buildCostJson(entries, { limit: 0 });
    expect(none.rows).toEqual([]);
    expect(none.total.cost).toBe(50);
    expect(buildCostJson(entries, { limit: 500 }).rows).toHaveLength(50);
  });

  it('filterCostEntries returns the entries untouched with no filter (#3187)', () => {
    const entries = load([row({ cost: 1 })]);
    expect(filterCostEntries(entries)).toBe(entries);
  });
});

describe('parseCostFilter', () => {
  it('parses valid values', () => {
    expect(parseCostFilter({})).toEqual({});
    expect(parseCostFilter({ issue: '4', since: '2026-10-10T00:00:00Z', limit: '5' })).toEqual({
      issue: '4',
      since: Date.parse('2026-10-10T00:00:00Z'),
      limit: 5,
    });
    expect(parseCostFilter({ since: '2026-10-10' }).since).toBe(Date.parse('2026-10-10T00:00:00Z'));
    expect(parseCostFilter({ limit: '0' })).toEqual({ limit: 0 });
  });

  it('rejects bad --since', () => {
    expect(() => parseCostFilter({ since: 'not-a-date' })).toThrow(/--since/);
    expect(() => parseCostFilter({ since: '' })).toThrow(/--since/);
  });

  it('rejects bad --limit', () => {
    for (const limit of ['-1', '1.5', 'abc', '']) expect(() => parseCostFilter({ limit })).toThrow(/--limit/);
  });
});
