import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { readPhaseSnapshot, type RunPhaseSnapshot } from '@on-par/factory-core';
import {
  readIssueRunState,
  type FailurePhase,
  type IssueRunState,
  type RunStatus,
} from '@on-par/factory-core/internal';

/** Row cap when `--limit` is not given. */
export const DEFAULT_RUNS_LIMIT = 50;

/** One row of `factory runs --json` (#2271). Unknown values are null, never omitted. */
export interface RunsRowJson {
  issue: number;
  lane: string | null;
  repo: string | null;
  status: RunStatus | null;
  phase: FailurePhase | null;
  branch: string | null;
  prNumber: number | null;
  model: string | null;
  attempts: number | null;
  startedAt: string | null;
  updatedAt: string;
}

/** `factory runs --json` payload (#2271). Additive changes only; bump schemaVersion on a breaking change. */
export interface RunsJson {
  schemaVersion: 1;
  runs: RunsRowJson[];
}

/** Parse `--limit`: absent → the default, otherwise a positive integer or an Error. */
export function parseRunsLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_RUNS_LIMIT;
  if (/^\d+$/.test(raw) && Number(raw) >= 1) return Number(raw);
  throw new Error(`invalid --limit '${raw}' — expected a positive integer`);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function time(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? -Infinity : t;
}

/**
 * Merge `issue-<n>.json` (IssueRunState) and `issue-<n>.phase.json` (RunPhaseSnapshot)
 * in `runsDir` into one row per issue, newest `updatedAt` first, capped at `limit`.
 * A missing dir is an empty list; malformed files are skipped and named in `skipped`.
 */
export async function buildRunsJson(
  runsDir: string,
  { limit = DEFAULT_RUNS_LIMIT }: { limit?: number } = {},
): Promise<{ json: RunsJson; skipped: string[] }> {
  let names: string[];
  try {
    names = await readdir(runsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { json: { schemaVersion: 1, runs: [] }, skipped: [] };
    throw err;
  }

  const byIssue = new Map<number, { run?: string; phase?: string }>();
  for (const name of names) {
    const phaseMatch = /^issue-(\d+)\.phase\.json$/.exec(name);
    const runMatch = phaseMatch ? null : /^issue-(\d+)\.json$/.exec(name);
    const match = phaseMatch ?? runMatch;
    if (!match) continue;
    const issue = Number(match[1]);
    const entry = byIssue.get(issue) ?? {};
    if (phaseMatch) entry.phase = name;
    else entry.run = name;
    byIssue.set(issue, entry);
  }

  const issues = [...byIssue.keys()].sort((a, b) => a - b);
  const skipped: string[] = [];
  const rows: RunsRowJson[] = [];
  const note = (name: string): void => {
    skipped.push(`factory: runs — skipped malformed ${name}`);
  };

  const loaded = await Promise.all(
    issues.map(async (issue) => {
      const files = byIssue.get(issue) ?? {};
      const bad: string[] = [];
      let state: IssueRunState | null = null;
      let snapshot: RunPhaseSnapshot | null = null;
      if (files.run !== undefined) {
        state = await readIssueRunState(join(runsDir, files.run));
        if (state === null || typeof state.updatedAt !== 'string') {
          state = null;
          bad.push(files.run);
        }
      }
      if (files.phase !== undefined) {
        snapshot = await readPhaseSnapshot(join(runsDir, files.phase));
        if (snapshot === null) bad.push(files.phase);
      }
      return { issue, state, snapshot, bad };
    }),
  );

  for (const { issue, state, snapshot, bad } of loaded) {
    bad.forEach(note);
    if (state === null && snapshot === null) continue;
    const updatedAt =
      state !== null && snapshot !== null
        ? time(snapshot.updatedAt) > time(state.updatedAt)
          ? snapshot.updatedAt
          : state.updatedAt
        : (state?.updatedAt ?? snapshot?.updatedAt ?? '');
    rows.push({
      issue,
      lane: str(state?.lane),
      repo: str(state?.repo),
      status: str(state?.status) as RunStatus | null,
      phase: snapshot?.phase ?? null,
      branch: str(state?.branch),
      prNumber: num(state?.prNumber),
      model: str(state?.model),
      attempts: num(state?.attempts),
      startedAt: str(state?.startedAt),
      updatedAt,
    });
  }

  rows.sort((a, b) => time(b.updatedAt) - time(a.updatedAt) || b.issue - a.issue);
  return { json: { schemaVersion: 1, runs: rows.slice(0, limit) }, skipped };
}
