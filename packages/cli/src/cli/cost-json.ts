import { aggregateCosts, type CostEntry } from '@on-par/factory-core';
import type { CostJson } from './json-contract.js';

/**
 * `factory cost --json` payload (#2269); additive changes bump schemaVersion only when breaking.
 * `total.tokens` sums input/output/rawInput/cacheRead/cacheCreation over the same filtered entries as `total.cost`;
 * a row with no split counts toward `input` only, so `input >= rawInput + cacheRead + cacheCreation` (#3212).
 */
export type { CostJson } from './json-contract.js';

/** One cost row in `factory cost --json` (#2269). CostEntry field names. */
export type CostRowJson = CostJson['rows'][number];

/**
 * Per-model rollup over the (filtered) rows, first-seen model order. Also sums rawInputTokens / cacheReadTokens /
 * cacheCreationTokens over those rows; a missing field adds 0 (#3212).
 */
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
      rawInputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      sum: number;
      priced: number;
      unpriced: number;
      cachedRateMissing: number;
    }
  >();
  let cachedRateMissingTotal = 0;
  const tokens = { input: 0, output: 0, rawInput: 0, cacheRead: 0, cacheCreation: 0 };
  for (const e of filtered) {
    const cost = e.unpriced === true || e.cost == null ? null : e.cost;
    const inputTokens = e.inputTokens ?? 0;
    const outputTokens = e.outputTokens ?? 0;
    const rawInputTokens = e.rawInputTokens ?? 0;
    const cacheReadTokens = e.cacheReadTokens ?? 0;
    const cacheCreationTokens = e.cacheCreationTokens ?? 0;
    rows.push({
      ts: e.ts,
      issue: e.issue,
      task: e.task,
      model: e.model,
      inputTokens,
      outputTokens,
      rawInputTokens: e.rawInputTokens ?? null,
      cacheReadTokens: e.cacheReadTokens ?? null,
      cacheCreationTokens: e.cacheCreationTokens ?? null,
      cost,
    });
    let m = models.get(e.model);
    if (m === undefined) {
      m = {
        tasks: 0,
        inputTokens: 0,
        outputTokens: 0,
        rawInputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        sum: 0,
        priced: 0,
        unpriced: 0,
        cachedRateMissing: 0,
      };
      models.set(e.model, m);
    }
    m.tasks += 1;
    m.inputTokens += inputTokens;
    m.outputTokens += outputTokens;
    m.rawInputTokens += rawInputTokens;
    m.cacheReadTokens += cacheReadTokens;
    m.cacheCreationTokens += cacheCreationTokens;
    tokens.input += inputTokens;
    tokens.output += outputTokens;
    tokens.rawInput += rawInputTokens;
    tokens.cacheRead += cacheReadTokens;
    tokens.cacheCreation += cacheCreationTokens;
    if (e.cachedRateMissing === true) {
      m.cachedRateMissing += 1;
      cachedRateMissingTotal += 1;
    }
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
    rawInputTokens: m.rawInputTokens,
    cacheReadTokens: m.cacheReadTokens,
    cacheCreationTokens: m.cacheCreationTokens,
    cost: m.priced === 0 && m.unpriced > 0 ? null : m.sum,
    unpricedCount: m.unpriced,
    cachedRateMissingCount: m.cachedRateMissing,
  }));
  const t = aggregateCosts(filtered).total;
  return {
    schemaVersion: 1,
    rows,
    perModel,
    total: { cost: t.cost, unpricedCount: t.unpricedCount, cachedRateMissingCount: cachedRateMissingTotal, tokens },
  };
}
