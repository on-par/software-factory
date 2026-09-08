// src/run/phase-snapshot.ts — The persisted RunPhaseSnapshot record (#1325, #1326). A
// minimal, truthful phase field for downstream connectors (e.g. Factory Assist's daemon
// `factory.run.snapshot`, per #1323) that today can only infer phase from log text. One
// JSON file per issue under getFactoryPaths(...).runs, written atomically the same way
// writeIssueRunState (./state.ts) does.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { FailurePhase } from '../types/index.js';

export interface RunPhaseSnapshot {
  issue: number;
  phase: FailurePhase;
  /** ISO-8601 timestamp of the phase transition this snapshot records. */
  updatedAt: string;
  /** ISO-8601 timestamp of the most recent recorded activity (#1326) — a heartbeat
   *  distinct from `updatedAt`: it also advances between phase transitions (e.g. around
   *  each checker during CHECK), so a downstream consumer can tell a long stage that is
   *  still making progress from one that has hung. */
  lastActivityAt: string;
}

const PHASES: readonly FailurePhase[] = ['plan', 'build', 'check', 'ship'];

/** Path of one issue's persisted phase snapshot inside `runsDir`
 *  (`getFactoryPaths(repoRoot).runs`). */
export function phaseSnapshotFile(runsDir: string, issue: number): string {
  return resolve(runsDir, `issue-${issue}.phase.json`);
}

/** Persists `snapshot` atomically (write to a tmp file, then rename). */
export async function writePhaseSnapshot(file: string, snapshot: RunPhaseSnapshot): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
  await rename(tmp, file);
}

/** Reads one issue's persisted phase snapshot, or null when the file is missing,
 *  unreadable, not a JSON object, or fails to carry a valid FailurePhase. Never throws. */
export async function readPhaseSnapshot(file: string): Promise<RunPhaseSnapshot | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf-8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Partial<RunPhaseSnapshot>;
  if (
    typeof record.issue !== 'number' ||
    typeof record.updatedAt !== 'string' ||
    typeof record.lastActivityAt !== 'string' ||
    !PHASES.includes(record.phase as FailurePhase)
  ) {
    return null;
  }
  return {
    issue: record.issue,
    phase: record.phase as FailurePhase,
    updatedAt: record.updatedAt,
    lastActivityAt: record.lastActivityAt,
  };
}

/** Read-modify-write: bumps a persisted snapshot's `lastActivityAt` heartbeat to `now`
 *  without disturbing `phase`/`updatedAt` — the CHECK-phase per-checker touch (#1326).
 *  A no-op when no snapshot exists yet for this file (recordPhase('check') always writes
 *  one before checkers run, so this only fires once that snapshot is in place). */
export async function touchRunActivity(file: string, now: string): Promise<void> {
  const existing = await readPhaseSnapshot(file);
  if (!existing) return;
  await writePhaseSnapshot(file, { ...existing, lastActivityAt: now });
}
