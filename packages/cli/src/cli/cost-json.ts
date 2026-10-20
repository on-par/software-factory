import { aggregateCosts, type CostEntry } from '@on-par/factory-core';
import type { CostJson } from './json-contract.js';

/** `factory cost --json` payload (#2269); additive changes bump schemaVersion only when breaking. */
export type { CostJson } from './json-contract.js';

/** One cost row in `factory cost --json` (#2269). CostEntry field names. */
export type CostRowJson = CostJson['rows'][number];

/** Per-model rollup over the (filtered) rows, first-seen model order. */
export type CostModelRowJson = CostJson['perModel'][number];

/** Build the `factory cost --json` payload; `issue` keeps only that issue's rows. */
export function buildCostJson(entries: CostEntry[], issue?: string): CostJson {
  const filtered = issue === undefined ? entries : entries.filter((e) => e.issue === String(issue));
  const rows: CostRowJson[] = [];
  const models = new Map<
    string,
    {
      tasks: number;
      inputTokens: number;
      outputTokens: number;
      sum: number;
      priced: number;
      unpriced: number;
      cachedRateMissing: number;
    }
  >();
  for (const e of filtered) {
    const cost = e.unpriced === true || e.cost == null ? null : e.cost;
    const inputTokens = e.inputTokens ?? 0;
    const outputTokens = e.outputTokens ?? 0;
    rows.push({
      ts: e.ts,
      issue: e.issue,
      task: e.task,
      model: e.model,
      inputTokens,
      outputTokens,
      cacheReadTokens: e.cacheReadTokens ?? null,
      cacheCreationTokens: e.cacheCreationTokens ?? null,
      cost,
    });
    let m = models.get(e.model);
    if (m === undefined) {
      m = { tasks: 0, inputTokens: 0, outputTokens: 0, sum: 0, priced: 0, unpriced: 0, cachedRateMissing: 0 };
      models.set(e.model, m);
    }
    m.tasks += 1;
    m.inputTokens += inputTokens;
    m.outputTokens += outputTokens;
    if (e.cachedRateMissing === true) m.cachedRateMissing++;
    if (cost === null) m.unpriced += 1;
    else {
      m.sum += cost;
      m.priced += 1;
    }
  }
  const perModel = [...models].map(([model, m]) => ({
    model,
    tasks: m.tasks,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    cost: m.priced === 0 && m.unpriced > 0 ? null : m.sum,
    unpricedCount: m.unpriced,
    cachedRateMissing: m.cachedRateMissing,
  }));
  const t = aggregateCosts(filtered).total;
  return {
    schemaVersion: 1,
    rows,
    perModel,
    total: {
      cost: t.cost,
      unpricedCount: t.unpricedCount,
      cachedRateMissing: filtered.filter((e) => e.cachedRateMissing === true).length,
    },
  };
}
