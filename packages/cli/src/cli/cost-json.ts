import { aggregateCosts, type CostEntry } from '@on-par/factory-core';

/** One cost row in `factory cost --json` (#2269). CostEntry field names. */
export interface CostRowJson {
  ts: string;
  issue: string;
  task: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /** null when unpriced (ADR-0020); never 0 for an unpriced row. */
  cost: number | null;
}

/** Per-model rollup over the (filtered) rows, first-seen model order. */
export interface CostModelRowJson {
  model: string;
  tasks: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of priced rows; null when every row for the model is unpriced. */
  cost: number | null;
  unpricedCount: number;
}

/** `factory cost --json` payload (#2269). Additive changes only; bump schemaVersion on a breaking change. */
export interface CostJson {
  schemaVersion: 1;
  rows: CostRowJson[];
  perModel: CostModelRowJson[];
  total: { cost: number | null; unpricedCount: number };
}

/** Build the `factory cost --json` payload; `issue` keeps only that issue's rows. */
export function buildCostJson(entries: CostEntry[], issue?: string): CostJson {
  const filtered = issue === undefined ? entries : entries.filter((e) => e.issue === String(issue));
  const rows: CostRowJson[] = [];
  const models = new Map<
    string,
    { tasks: number; inputTokens: number; outputTokens: number; sum: number; priced: number; unpriced: number }
  >();
  for (const e of filtered) {
    const unpriced = e.unpriced === true || e.cost === null || e.cost === undefined;
    const cost = unpriced ? null : (e.cost as number);
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
      m = { tasks: 0, inputTokens: 0, outputTokens: 0, sum: 0, priced: 0, unpriced: 0 };
      models.set(e.model, m);
    }
    m.tasks += 1;
    m.inputTokens += inputTokens;
    m.outputTokens += outputTokens;
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
  }));
  const t = aggregateCosts(filtered).total;
  return { schemaVersion: 1, rows, perModel, total: { cost: t.cost, unpricedCount: t.unpricedCount } };
}
