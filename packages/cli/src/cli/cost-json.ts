import { aggregateCosts, type CostEntry } from '@on-par/factory-core';
import { CliExitError } from './errors.js';
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

/**
 * `factory cost` filter (#3187): `issue` and `since` (epoch ms) scope every rollup and row; `limit` caps only the
 * newest rows shown, never perModel or total.
 */
export interface CostFilter {
  issue?: string;
  since?: number;
  limit?: number;
}

/** Validate the raw `--issue` / `--since` / `--limit` strings; throws an Error naming the bad flag (#3187). */
export function parseCostFilter(opts: { issue?: string; since?: string; limit?: string }): CostFilter {
  const filter: CostFilter = {};
  if (opts.issue !== undefined) filter.issue = opts.issue;
  if (opts.since !== undefined) {
    const t = opts.since.trim() === '' ? Number.NaN : Date.parse(opts.since.trim());
    if (Number.isNaN(t)) {
      throw new Error(`invalid --since '${opts.since}' — expected an ISO 8601 time, e.g. 2026-10-10T00:00:00Z`);
    }
    filter.since = t;
  }
  if (opts.limit !== undefined) {
    if (!/^\d+$/.test(opts.limit)) throw new Error(`invalid --limit '${opts.limit}' — expected a non-negative integer`);
    filter.limit = Number(opts.limit);
  }
  return filter;
}

/** `parseCostFilter` that fails as a CLI exit 1 before anything is read or printed (#3187). */
export function parseCostFilterOrExit(opts: { issue?: string; since?: string; limit?: string }): CostFilter {
  try {
    return parseCostFilter(opts);
  } catch (err) {
    throw new CliExitError(`factory: cost failed — ${err instanceof Error ? err.message : String(err)}`, 1);
  }
}

/** Keep entries matching `issue` and at or after `since`; an unparsable `ts` is dropped when `since` is set. */
export function filterCostEntries(entries: CostEntry[], filter: CostFilter = {}): CostEntry[] {
  const { issue, since } = filter;
  if (issue === undefined && since === undefined) return entries;
  return entries.filter((e) => {
    if (issue !== undefined && e.issue !== String(issue)) return false;
    return since === undefined || Date.parse(e.ts) >= since;
  });
}

/** The newest `limit` items (input order kept); no `limit` keeps all. `slice(-0)` would keep everything, so avoid it. */
export function newestCostItems<T>(items: T[], limit?: number): T[] {
  return limit === undefined ? items : items.slice(items.length - Math.min(limit, items.length));
}

/** Build the `factory cost --json` payload; `issue` and `since` scope everything, `limit` caps only `rows`. */
export function buildCostJson(entries: CostEntry[], filter: CostFilter = {}): CostJson {
  const filtered = filterCostEntries(entries, filter);
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
    rows: newestCostItems(rows, filter.limit),
    perModel,
    total: { cost: t.cost, unpricedCount: t.unpricedCount, cachedRateMissingCount: cachedRateMissingTotal, tokens },
  };
}
