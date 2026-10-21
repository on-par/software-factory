// packages/grade/src/load-runs.ts — loads recorded runs through core's run store reader; read-only, never writes.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { readIssueRunState, type IssueRunState } from '@on-par/factory-core/internal';

export interface LoadRunsOptions {
  /** Keep only runs whose startedAt is on or after this instant. */
  since?: Date;
  /** Run-store reader; defaults to core's readIssueRunState. Injected by tests. */
  readRun?: (file: string) => Promise<IssueRunState | null>;
}

export interface LoadRunsResult {
  runs: IssueRunState[];
  /** File names that matched issue-<n>.json but did not read as a run record. */
  skipped: string[];
}

/**
 * Read every `issue-<n>.json` in `runsDir` (`getFactoryPaths(repoRoot).runs`), sorted by
 * startedAt then issue. A missing dir is an empty result; unreadable records are named in `skipped`.
 */
export async function loadRuns(runsDir: string, options: LoadRunsOptions = {}): Promise<LoadRunsResult> {
  const { since, readRun = readIssueRunState } = options;
  if (since !== undefined && Number.isNaN(since.getTime())) throw new RangeError('invalid since date');

  let names: string[];
  try {
    names = await readdir(runsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { runs: [], skipped: [] };
    throw err;
  }

  const files = names.filter((name) => /^issue-(\d+)\.json$/.test(name)).sort();
  const runs: IssueRunState[] = [];
  const skipped: string[] = [];
  for (const name of files) {
    const run = await readRun(join(runsDir, name));
    if (run === null || typeof run.startedAt !== 'string') {
      skipped.push(name);
      continue;
    }
    if (since !== undefined) {
      const started = Date.parse(run.startedAt);
      if (Number.isNaN(started) || started < since.getTime()) continue;
    }
    runs.push(run);
  }

  const time = (run: IssueRunState): number => {
    const t = Date.parse(run.startedAt);
    return Number.isNaN(t) ? -Infinity : t;
  };
  runs.sort((a, b) => {
    const ta = time(a);
    const tb = time(b);
    if (ta === tb) return a.issue - b.issue;
    return ta < tb ? -1 : 1;
  });
  return { runs, skipped };
}
