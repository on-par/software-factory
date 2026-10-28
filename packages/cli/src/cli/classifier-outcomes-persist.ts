// packages/cli/src/cli/classifier-outcomes-persist.ts — join and persist PR classifier outcomes for `factory kpis`

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  joinClassifierOutcomes,
  mergeClassifierOutcomes,
  type getFactoryPaths,
  type PrSource,
} from '@on-par/factory-core';
import { ensureDir } from '@on-par/factory-core/internal';

export function persistClassifierOutcomes(
  paths: ReturnType<typeof getFactoryPaths>,
  events: Parameters<typeof joinClassifierOutcomes>[0],
  sources: PrSource[],
  opts: { now: string; windowDays: number },
): void {
  const records = joinClassifierOutcomes(events, sources, opts);
  if (records.length === 0) return;
  const existing = existsSync(paths.classifierOutcomes) ? readFileSync(paths.classifierOutcomes, 'utf-8') : '';
  ensureDir(paths.state);
  writeFileSync(paths.classifierOutcomes, mergeClassifierOutcomes(existing, records));
}
