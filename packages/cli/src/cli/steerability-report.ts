import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseClassifierOutcomes } from '@on-par/factory-core';
import {
  collectMergedPrSteers,
  readIssueRunState,
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

/** Every parseable `issue-<n>.json` run state in `runsDir`; phase snapshots and malformed files are skipped. */
export async function readRunStates(runsDir: string): Promise<IssueRunState[]> {
  const names = await readOrEmpty(() => readdir(runsDir), [] as string[]);
  const states = await Promise.all(
    names.filter((name) => /^issue-(\d+)\.json$/.test(name)).map((name) => readIssueRunState(join(runsDir, name))),
  );
  return states.filter((s): s is IssueRunState => s !== null && typeof s.issue === 'number');
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
