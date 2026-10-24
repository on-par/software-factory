// src/utils/cost-log.ts — append-only cost ledger helpers, split out of utils/index.ts

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { CostEntry } from '../types/index.js';

export function logCost(costsFile: string, entry: Omit<CostEntry, 'ts'>): void {
  const full: CostEntry = { ...entry, ts: new Date().toISOString() };
  const line = JSON.stringify(full) + '\n';
  try {
    appendFileSync(costsFile, line);
  } catch {
    mkdirSync(resolve(costsFile, '..'), { recursive: true });
    appendFileSync(costsFile, line);
  }
}

export function readCosts(costsFile: string): CostEntry[] {
  if (!existsSync(costsFile)) return [];
  return readFileSync(costsFile, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as CostEntry];
      } catch {
        return [];
      }
    });
}
