// src/utils/awaiting-ci.ts — persisted records and re-check backoff for PRs whose CI never started (#3208)

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** A PR left open because no check run or commit status ever registered on its head. */
export interface AwaitingCiRecord {
  issue: number;
  prNumber: number;
  branch: string;
  headSha: string;
  firstSeenAt: number;
  attempts: number;
  nextRecheckAt: number;
}

export const AWAITING_CI_BACKOFF_MS: readonly number[] = [2, 5, 15].map((m) => m * 60_000);
export const AWAITING_CI_INTERVAL_MS = 30 * 60_000;
const DEFAULT_AWAITING_CI_CAP_HOURS = 24;

/** When re-check number `attempts` (0-based) falls due: +2m, +5m, +15m after firstSeenAt, then every 30m. */
export function nextRecheckAt(firstSeenAt: number, attempts: number): number {
  if (attempts < AWAITING_CI_BACKOFF_MS.length) return firstSeenAt + AWAITING_CI_BACKOFF_MS[attempts];
  const last = AWAITING_CI_BACKOFF_MS[AWAITING_CI_BACKOFF_MS.length - 1];
  return firstSeenAt + last + (attempts - AWAITING_CI_BACKOFF_MS.length + 1) * AWAITING_CI_INTERVAL_MS;
}

/** ci.awaitingCiCapHours as ms; missing, non-finite or <= 0 falls back to 24 hours. */
export function resolveAwaitingCiCapMs(config: { ci?: { awaitingCiCapHours?: number } }): number {
  const h = config.ci?.awaitingCiCapHours;
  const hours = typeof h === 'number' && Number.isFinite(h) && h > 0 ? h : DEFAULT_AWAITING_CI_CAP_HOURS;
  return hours * 3_600_000;
}

export function awaitingCiFile(paths: { state: string }): string {
  return join(paths.state, 'awaiting-ci.json');
}

function isRecord(v: unknown): v is AwaitingCiRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.issue === 'number' &&
    typeof r.prNumber === 'number' &&
    typeof r.branch === 'string' &&
    typeof r.headSha === 'string' &&
    typeof r.firstSeenAt === 'number' &&
    typeof r.attempts === 'number' &&
    typeof r.nextRecheckAt === 'number'
  );
}

/** Reads the records. A missing or malformed file reads as empty; this never throws. */
export async function readAwaitingCi(file: string): Promise<AwaitingCiRecord[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

async function writeAll(file: string, records: readonly AwaitingCiRecord[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/** Inserts or replaces the record for `record.issue`. */
export async function upsertAwaitingCi(file: string, record: AwaitingCiRecord): Promise<void> {
  const rest = (await readAwaitingCi(file)).filter((r) => r.issue !== record.issue);
  await writeAll(file, [...rest, record]);
}

export async function clearAwaitingCi(file: string, issue: number): Promise<void> {
  const all = await readAwaitingCi(file);
  const rest = all.filter((r) => r.issue !== issue);
  if (rest.length !== all.length) await writeAll(file, rest);
}
