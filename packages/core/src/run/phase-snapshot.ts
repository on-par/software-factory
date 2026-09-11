// src/run/phase-snapshot.ts — The persisted RunPhaseSnapshot record (#1325, #1326). A
// minimal, truthful phase field for downstream connectors (e.g. Factory Assist's daemon
// `factory.run.snapshot`, per #1323) that today can only infer phase from log text. One
// JSON file per issue under getFactoryPaths(...).runs, written atomically the same way
// writeIssueRunState (./state.ts) does.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { EventKind } from '../events/kinds.js';
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
  /** Short human-readable summary of the most recent daemon event (#1327), via
   *  `summarizeEvent`. Absent until the CLI's mkLog chokepoint has logged at least one
   *  event after the first snapshot write — optional/absent-safe for consumers. */
  lastEvent?: string;
}

const LAST_EVENT_MAX_LENGTH = 200;

/** Renders a short, human-readable one-line summary of a logged event for `lastEvent`
 *  (#1327), truncated so a verbose event message can't bloat the snapshot file. */
export function summarizeEvent(type: EventKind, msg: string): string {
  const trimmed = msg.trim();
  const summary = trimmed.length > 0 ? `${type}: ${trimmed}` : type;
  return summary.length > LAST_EVENT_MAX_LENGTH ? `${summary.slice(0, LAST_EVENT_MAX_LENGTH - 1)}…` : summary;
}

const PHASES: readonly FailurePhase[] = ['plan', 'build', 'check', 'ship'];

/** Path of one issue's persisted phase snapshot inside `runsDir`
 *  (`getFactoryPaths(repoRoot).runs`). */
export function phaseSnapshotFile(runsDir: string, issue: number): string {
  return resolve(runsDir, `issue-${issue}.phase.json`);
}

// One promise chain per snapshot file. recordPhase (a plain write), touchRunActivity, and
// touchLastEvent (#1327) are all fired unawaited from the CLI's mkLog chokepoint, several
// times per tick. Chaining every write AND every read-modify-write on the same file keeps
// (a) two tmp-write/rename pairs from interleaving and corrupting the file, and (b) a touch
// that read an older snapshot from landing after a newer phase write and regressing it
// (#1371). A failed step never blocks the next. Different issues use different files.
const fileChains = new Map<string, Promise<void>>();

function serializedPerFile(file: string, op: () => Promise<void>): Promise<void> {
  const prev = fileChains.get(file) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(op);
  fileChains.set(file, next);
  void next
    .catch(() => undefined)
    .finally(() => {
      if (fileChains.get(file) === next) fileChains.delete(file);
    });
  return next;
}

async function writeSnapshotFile(file: string, snapshot: RunPhaseSnapshot): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
  await rename(tmp, file);
}

/** Persists `snapshot` atomically (write to a tmp file, then rename), in call order with
 *  every other write or touch on the same file. */
export async function writePhaseSnapshot(file: string, snapshot: RunPhaseSnapshot): Promise<void> {
  return serializedPerFile(file, () => writeSnapshotFile(file, snapshot));
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
    ...(typeof record.lastEvent === 'string' ? { lastEvent: record.lastEvent } : {}),
  };
}

/** Read-modify-write: bumps a persisted snapshot's `lastActivityAt` heartbeat to `now`
 *  without disturbing `phase`/`updatedAt` — the CHECK-phase per-checker touch (#1326).
 *  A no-op when no snapshot exists yet for this file (recordPhase('check') always writes
 *  one before checkers run, so this only fires once that snapshot is in place). */
export async function touchRunActivity(file: string, now: string): Promise<void> {
  return serializedPerFile(file, async () => {
    const existing = await readPhaseSnapshot(file);
    if (!existing) return;
    await writeSnapshotFile(file, { ...existing, lastActivityAt: now });
  });
}

/** Read-modify-write: sets a persisted snapshot's `lastEvent` summary (#1327) without
 *  disturbing `phase`/`updatedAt`/`lastActivityAt` — the CLI's mkLog chokepoint calls this
 *  for every logged event. A no-op when no snapshot exists yet for this file (mirrors
 *  `touchRunActivity`): the first events of a run are logged before PLAN's first
 *  `recordPhase` write, and this is an observability side channel, not a run invariant. */
export async function touchLastEvent(file: string, lastEvent: string): Promise<void> {
  return serializedPerFile(file, async () => {
    const existing = await readPhaseSnapshot(file);
    if (!existing) return;
    await writeSnapshotFile(file, { ...existing, lastEvent });
  });
}
