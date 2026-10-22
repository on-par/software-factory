import { readFile } from 'node:fs/promises';

import { parseClassifierOutcomes } from '@on-par/factory-core';
import {
  collectMergedPrSteers,
  listIssueRuns,
  summarizeSteerability,
  type IssueRunState,
  type SteerabilityReport,
} from '@on-par/factory-core/internal';

async function readOrEmpty<T>(read: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty;
    throw err;
  }
}

/** Every parseable `issue-<n>.json` run state in `runsDir`; phase snapshots and invalid records are skipped (core's listIssueRuns). */
export async function readRunStates(runsDir: string): Promise<IssueRunState[]> {
  return (await listIssueRuns(runsDir)).runs;
}

/** Steers per merged PR from local run states and classifier-outcomes.jsonl (#3403). */
export async function buildSteerabilityReport(paths: {
  runs: string;
  classifierOutcomes: string;
}): Promise<SteerabilityReport> {
  const text = await readOrEmpty(() => readFile(paths.classifierOutcomes, 'utf-8'), '');
  const runs = await readRunStates(paths.runs);
  const { rows, unmatched } = collectMergedPrSteers(runs, parseClassifierOutcomes(text));
  return summarizeSteerability(rows, unmatched);
}
