// src/queue/land-deferred.ts — host-local retry queue for lands starved by a moving base (#3957)

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** A PR left open because origin/main kept moving past every land sync round. */
export interface LandDeferredRecord {
  issue: number;
  prNumber: number;
  branch: string;
  firstDeferredAt: number;
  deferrals: number;
  nextRetryAt: number;
  lastMessage: string;
}

/** Wait before retry 1, 2, 3...; the last value repeats. */
export const LAND_DEFER_BACKOFF_MS: readonly number[] = [1, 2, 4].map((m) => m * 60_000);
export const DEFAULT_MAX_LAND_DEFERRALS = 3;

/** merge.maxLandDeferrals when it is an integer in 1-10, otherwise 3. */
export function resolveMaxLandDeferrals(config: { merge?: { maxLandDeferrals?: number } }): number {
  const n = config.merge?.maxLandDeferrals;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 10 ? n : DEFAULT_MAX_LAND_DEFERRALS;
}

export type LandDeferralDecision =
  { kind: 'defer'; record: LandDeferredRecord } | { kind: 'park'; deferrals: number; message: string };

/** Defers with backoff until `maxDeferrals` deferrals are spent, then parks. */
export function decideLandDeferral(
  prev: LandDeferredRecord | undefined,
  next: { issue: number; prNumber: number; branch: string; message: string },
  opts: { now: number; maxDeferrals: number },
): LandDeferralDecision {
  const n = prev?.deferrals ?? 0;
  if (n >= opts.maxDeferrals) return { kind: 'park', deferrals: n, message: next.message };
  return {
    kind: 'defer',
    record: {
      issue: next.issue,
      prNumber: next.prNumber,
      branch: next.branch,
      firstDeferredAt: prev?.firstDeferredAt ?? opts.now,
      deferrals: n + 1,
      nextRetryAt: opts.now + LAND_DEFER_BACKOFF_MS[Math.min(n, LAND_DEFER_BACKOFF_MS.length - 1)],
      lastMessage: next.message,
    },
  };
}

/** Records whose retry is due, oldest deferral first (ties by issue number). */
export function dueLandDeferrals(records: readonly LandDeferredRecord[], now: number): LandDeferredRecord[] {
  return records
    .filter((r) => r.nextRetryAt <= now)
    .sort((a, b) => a.firstDeferredAt - b.firstDeferredAt || a.issue - b.issue);
}

export function landDeferredFile(paths: { state: string }): string {
  return join(paths.state, 'land-deferred.json');
}

function isRecord(v: unknown): v is LandDeferredRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.issue === 'number' &&
    typeof r.prNumber === 'number' &&
    typeof r.branch === 'string' &&
    typeof r.firstDeferredAt === 'number' &&
    typeof r.deferrals === 'number' &&
    typeof r.nextRetryAt === 'number' &&
    typeof r.lastMessage === 'string'
  );
}

/** Reads the records. A missing or malformed file reads as empty; this never throws. */
export async function readLandDeferred(file: string): Promise<LandDeferredRecord[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

async function writeAll(file: string, records: readonly LandDeferredRecord[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/** Inserts or replaces the record for `record.issue`. */
export async function upsertLandDeferred(file: string, record: LandDeferredRecord): Promise<void> {
  const rest = (await readLandDeferred(file)).filter((r) => r.issue !== record.issue);
  await writeAll(file, [...rest, record]);
}

export async function clearLandDeferred(file: string, issue: number): Promise<void> {
  const all = await readLandDeferred(file);
  const rest = all.filter((r) => r.issue !== issue);
  if (rest.length !== all.length) await writeAll(file, rest);
}
