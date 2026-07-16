// src/usage/index.ts — Claude Code transcript usage estimation helpers

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { logEvent } from '../utils/index.js';
import { fetchSubscriptionUsage } from './subscription.js';
import type { SubscriptionUsage } from './subscription.js';
import type { CostEntry } from '../types/index.js';

export const TRAILING_WINDOW_MS = 5 * 60 * 60 * 1000;

// Cost weights ($/Mtok input, output). Substring match on model id, first hit
// wins; unknown claude-* models fall back to sonnet pricing.
const PRICES: Array<{ match: string; input: number; output: number }> = [
  { match: 'opus', input: 15, output: 75 },
  { match: 'fable', input: 15, output: 75 },
  { match: 'mythos', input: 15, output: 75 },
  { match: 'sonnet', input: 3, output: 15 },
  { match: 'haiku', input: 1, output: 5 },
];
const DEFAULT_PRICE = { input: 3, output: 15 };

export interface TrailingUsageOptions {
  roots?: string[];
  now?: Date;
  windowMs?: number;
}

export function priceFor(model: string): { input: number; output: number } {
  const price = PRICES.find(candidate => model.includes(candidate.match)) ?? DEFAULT_PRICE;
  return { input: price.input, output: price.output };
}

export function defaultTranscriptRoots(): string[] {
  return [
    resolve(homedir(), '.claude/projects'),
    resolve(homedir(), '.config/claude/projects'),
  ];
}

export function estimateTrailingSpend(opts: TrailingUsageOptions = {}): number {
  const roots = opts.roots ?? defaultTranscriptRoots();
  const now = opts.now ?? new Date();
  const windowMs = opts.windowMs ?? TRAILING_WINDOW_MS;
  const endTs = now.getTime();
  const startTs = endTs - windowMs;
  let total = 0;

  for (const root of roots) {
    if (!existsSync(root)) continue;

    let entries: string[];
    try {
      entries = readdirSync(root, { recursive: true }).filter((entry): entry is string => typeof entry === 'string');
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;

      const file = resolve(root, entry);
      try {
        if (statSync(file).mtimeMs < startTs) continue;

        for (const line of readFileSync(file, 'utf-8').split('\n')) {
          if (!line.includes('"usage"')) continue;

          let data: any;
          try {
            data = JSON.parse(line);
          } catch {
            continue;
          }

          const usage = data.message?.usage;
          const model = data.message?.model;
          if (!usage || !data.timestamp || typeof model !== 'string' || !model.startsWith('claude-')) continue;

          const timestamp = Date.parse(data.timestamp);
          if (Number.isNaN(timestamp) || timestamp < startTs || timestamp > endTs) continue;

          const { input, output } = priceFor(model);
          total += (
            (usage.input_tokens ?? 0) * input
            + (usage.output_tokens ?? 0) * output
            + (usage.cache_read_input_tokens ?? 0) * input * 0.1
            + (usage.cache_creation_input_tokens ?? 0) * input * 1.25
          ) / 1e6;
        }
      } catch {
        continue;
      }
    }
  }

  return total;
}

export function formatUsageReport(spend: number, cap: number): string {
  return `trailing-5h usage ~= $${spend.toFixed(0)} = ${Math.round((spend / cap) * 100)}% of $${cap.toFixed(0)} cap`;
}

// ---------- Unified usage reading (real subscription signal, estimator fallback) ----------

export type UsageSource = 'subscription' | 'estimate';

export interface UsageReading {
  pct: number;
  source: UsageSource;
  detail: string;
}

export interface ReadUsageOptions {
  cap: number;
  estimator: boolean;
  fetchSubscription?: () => Promise<SubscriptionUsage | null>;
  estimateSpend?: () => number;
}

/**
 * Prefers the real Anthropic subscription rate-limit signal over the list-price
 * transcript heuristic, which cannot be calibrated against the real 5h window.
 * The estimator is opt-in only (FACTORY_USAGE_ESTIMATOR=1) and used solely when
 * the subscription signal is unavailable (expired/missing token, offline, etc).
 */
export async function readUsage(opts: ReadUsageOptions): Promise<UsageReading | null> {
  const {
    cap,
    estimator,
    fetchSubscription = fetchSubscriptionUsage,
    estimateSpend = () => estimateTrailingSpend(),
  } = opts;

  const subscription = await fetchSubscription();
  if (subscription !== null) {
    const detail = `5h subscription window at ${Math.round(subscription.fiveHourUtilization)}%`
      + (subscription.fiveHourResetsAt ? `, resets ${subscription.fiveHourResetsAt}` : '');
    return { pct: subscription.fiveHourUtilization / 100, source: 'subscription', detail };
  }

  if (estimator) {
    const spend = estimateSpend();
    return { pct: spend / cap, source: 'estimate', detail: formatUsageReport(spend, cap) };
  }

  return null;
}

export interface WatchUsageOptions {
  cap: number;
  stopAt: number;
  pollMs: number;
  stopFile: string;
  eventsFile: string;
  signal?: AbortSignal;
  estimator?: boolean;
  readUsageFn?: () => Promise<UsageReading | null>;
  emitEvent?: typeof logEvent;
  setStop?: (file: string) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();

  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export async function watchUsage(opts: WatchUsageOptions): Promise<'stopped' | 'aborted'> {
  const {
    cap,
    stopAt,
    pollMs,
    stopFile,
    eventsFile,
    signal,
    estimator = false,
    readUsageFn = () => readUsage({ cap, estimator }),
    emitEvent = logEvent,
    setStop = (file: string) => writeFileSync(file, ''),
    sleep: wait = sleep,
  } = opts;

  emitEvent(
    eventsFile,
    'watchdog',
    'usage',
    `usage watchdog armed: stop at ${Math.round(stopAt * 100)}% of $${cap.toFixed(0)} cap, poll ${pollMs / 1000}s`,
  );

  let unavailableWarned = false;

  while (!signal?.aborted) {
    const reading = await readUsageFn();

    if (reading === null) {
      if (!unavailableWarned) {
        unavailableWarned = true;
        emitEvent(
          eventsFile,
          'usage-unavailable',
          'usage',
          'usage signal unavailable — watchdog idle (set FACTORY_USAGE_ESTIMATOR=1 to gate on the list-price heuristic)',
        );
      }
    } else {
      unavailableWarned = false;
      if (reading.pct >= stopAt) {
        setStop(stopFile);
        emitEvent(
          eventsFile,
          'usage-stop',
          'usage',
          `${reading.detail} -- STOP set, lanes halt between issues`,
        );
        return 'stopped';
      }
    }

    await wait(pollMs, signal);
  }

  return 'aborted';
}

// ---------- Cost reading + aggregation (TUI Costs tab) ----------

export interface CostsRead {
  entries: CostEntry[];
  skipped: number;
}

function isValidCostEntry(value: unknown): value is CostEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.issue === 'string'
    && typeof v.model === 'string'
    && Number.isFinite(v.cost)
    && (v.inputTokens === undefined || Number.isFinite(v.inputTokens))
    && (v.outputTokens === undefined || Number.isFinite(v.outputTokens))
    && (v.failoverReason === undefined || typeof v.failoverReason === 'string')
  );
}

/** Like readCosts (utils/index.ts) but counts malformed/wrong-shape lines instead of silently dropping them. */
export function readCostsFile(costsFile: string): CostsRead {
  if (!existsSync(costsFile)) return { entries: [], skipped: 0 };

  const entries: CostEntry[] = [];
  let skipped = 0;

  for (const line of readFileSync(costsFile, 'utf-8').trim().split('\n').filter(Boolean)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }

    if (isValidCostEntry(parsed)) {
      entries.push(parsed);
    } else {
      skipped++;
    }
  }

  return { entries, skipped };
}

export interface ModelCostRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  tasks: number;
}

export interface IssueCostRow {
  issue: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  perModel: ModelCostRow[];
}

export interface CostsSummary {
  perIssue: IssueCostRow[];
  total: { inputTokens: number; outputTokens: number; cost: number };
}

/** Group cost entries by issue (first-seen order), with a nested per-model rollup and a grand total. Pure, no I/O. */
export function aggregateCosts(entries: CostEntry[]): CostsSummary {
  const issueOrder: string[] = [];
  const byIssue = new Map<string, IssueCostRow>();
  const modelByIssue = new Map<string, Map<string, ModelCostRow>>();
  const total = { inputTokens: 0, outputTokens: 0, cost: 0 };

  for (const e of entries) {
    const inputTokens = e.inputTokens ?? 0;
    const outputTokens = e.outputTokens ?? 0;
    const cost = e.cost ?? 0;

    if (!byIssue.has(e.issue)) {
      issueOrder.push(e.issue);
      byIssue.set(e.issue, { issue: e.issue, inputTokens: 0, outputTokens: 0, cost: 0, perModel: [] });
      modelByIssue.set(e.issue, new Map());
    }

    const issueRow = byIssue.get(e.issue)!;
    issueRow.inputTokens += inputTokens;
    issueRow.outputTokens += outputTokens;
    issueRow.cost += cost;

    const models = modelByIssue.get(e.issue)!;
    const modelRow = models.get(e.model) ?? { model: e.model, inputTokens: 0, outputTokens: 0, cost: 0, tasks: 0 };
    modelRow.inputTokens += inputTokens;
    modelRow.outputTokens += outputTokens;
    modelRow.cost += cost;
    modelRow.tasks += 1;
    models.set(e.model, modelRow);

    total.inputTokens += inputTokens;
    total.outputTokens += outputTokens;
    total.cost += cost;
  }

  const perIssue = issueOrder.map(issue => ({
    ...byIssue.get(issue)!,
    perModel: Array.from(modelByIssue.get(issue)!.values()),
  }));

  return { perIssue, total };
}
