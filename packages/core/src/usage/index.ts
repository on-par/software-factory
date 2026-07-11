// src/usage/index.ts — Claude Code transcript usage estimation helpers

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

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
