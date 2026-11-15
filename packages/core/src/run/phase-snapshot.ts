import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { EventKind } from '../events/kinds.js';
import type { FailurePhase } from '../types/index.js';
import type { WorkKey } from '../work/work-key.js';

export interface RunPhaseSnapshot {
  issue: number;
  phase: FailurePhase;
  updatedAt: string;
  lastActivityAt: string;
  lastEvent?: string;
}

const LAST_EVENT_MAX_LENGTH = 200;

export function summarizeEvent(type: EventKind, msg: string): string {
  const trimmed = msg.trim();
  const summary = trimmed.length > 0 ? `${type}: ${trimmed}` : type;
  return summary.length > LAST_EVENT_MAX_LENGTH ? `${summary.slice(0, LAST_EVENT_MAX_LENGTH - 1)}…` : summary;
}

const PHASES: ReadonlySet<FailurePhase> = new Set<FailurePhase>(['plan', 'build', 'check', 'ship']);

export function phaseSnapshotFile(runsDir: string, key: WorkKey): string {
  return resolve(runsDir, `issue-${key}.phase.json`);
}

const serialWriteChainByFile = new Map<string, Promise<void>>();

function serializedPerFile(file: string, op: () => Promise<void>): Promise<void> {
  const prev = serialWriteChainByFile.get(file) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(op);
  serialWriteChainByFile.set(file, next);
  void next
    .catch(() => undefined)
    .finally(() => {
      if (serialWriteChainByFile.get(file) === next) serialWriteChainByFile.delete(file);
    });
  return next;
}

async function writeSnapshotFile(file: string, snapshot: RunPhaseSnapshot): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

export async function writePhaseSnapshot(file: string, snapshot: RunPhaseSnapshot): Promise<void> {
  return serializedPerFile(file, () => writeSnapshotFile(file, snapshot));
}

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
    !PHASES.has(record.phase as FailurePhase)
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

export async function touchRunActivity(file: string, now: string): Promise<void> {
  return serializedPerFile(file, async () => {
    const existing = await readPhaseSnapshot(file);
    if (!existing) return;
    await writeSnapshotFile(file, { ...existing, lastActivityAt: now });
  });
}

export async function touchLastEvent(file: string, lastEvent: string): Promise<void> {
  return serializedPerFile(file, async () => {
    const existing = await readPhaseSnapshot(file);
    if (!existing) return;
    await writeSnapshotFile(file, { ...existing, lastEvent });
  });
}
