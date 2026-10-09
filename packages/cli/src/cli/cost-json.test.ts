import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readCosts } from '@on-par/factory-core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCostJson } from './cost-json.js';

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
    expect(json.total).toEqual({ cost: 3.5, unpricedCount: 0 });
    expect(json.perModel[0]).toMatchObject({ model: 'a', tasks: 2, cost: 1.5 });
    expect(json.rows[0]).toEqual({ ...row({}), cacheReadTokens: 3, cacheCreationTokens: 4, cost: 1 });
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
    expect(json.rows.map((r) => r.cost)).toEqual([2, null, null, null, null]);
    expect(json.total).toEqual({ cost: 2, unpricedCount: 4 });
    expect(json.perModel.find((m) => m.model === 'u')).toMatchObject({ cost: null, unpricedCount: 1 });
    expect(json.perModel.find((m) => m.model === 'a')).toMatchObject({ cost: 2, unpricedCount: 1 });
  });

  it('gives null total when everything is unpriced', () => {
    const json = buildCostJson(load([row({ cost: null, unpriced: true })]));
    expect(json.total).toEqual({ cost: null, unpricedCount: 1 });
  });

  it('filters by issue', () => {
    const entries = load([row({ cost: 1 }), row({ issue: '2', model: 'b', cost: 4 })]);
    const json = buildCostJson(entries, '2');
    expect(json.rows).toHaveLength(1);
    expect(json.perModel.map((m) => m.model)).toEqual(['b']);
    expect(json.total).toEqual({ cost: 4, unpricedCount: 0 });
    const none = buildCostJson(entries, '99');
    expect(none).toEqual({ schemaVersion: 1, rows: [], perModel: [], total: { cost: 0, unpricedCount: 0 } });
  });

  it('handles empty and missing files', () => {
    const empty = { schemaVersion: 1, rows: [], perModel: [], total: { cost: 0, unpricedCount: 0 } };
    expect(buildCostJson(load([]))).toEqual(empty);
    expect(buildCostJson(readCosts(join(dir, 'missing.jsonl')))).toEqual(empty);
  });

  it('nulls missing cache fields', () => {
    const [r] = buildCostJson(load([row({ cost: 1 })])).rows;
    expect(r?.cacheReadTokens).toBeNull();
    expect(r?.cacheCreationTokens).toBeNull();
  });
});
